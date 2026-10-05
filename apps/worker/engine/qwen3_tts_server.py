"""MakeMovie 内嵌语音引擎 sidecar（r10 音频体系·路径 2）。

一个常驻的本地推理进程：加载 Qwen3-TTS（MLX）一次，之后每个生成请求只做
推理（首响后单句 ~5-8s）。worker 用 HTTP 与它对话——不把 Python 塞进
Node 进程，也不依赖 Voicebox。

契约：
  GET  /health            → {"status":"loading"|"ready"|"error", "model":..., "error":...}
  POST /generate          → body: {"text":..., "ref_audio_path":..., "ref_text":...}
                            resp: audio/wav bytes（200）或 JSON error（4xx/5xx）

模型由安装流程预下载（snapshot_download 到引擎目录的 hf/ 下），所以本进程
默认 HF_HUB_OFFLINE=1——绝不在线上任务里隐式拉模型。
"""

import argparse
import glob
import json
import os
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"

state = {"status": "loading", "model": "", "error": None}
generate_lock = threading.Lock()  # MLX 单 GPU：推理串行


def load_engine(model_id: str):
    from mlx_audio.tts.utils import load_model

    state["model"] = model_id
    model = load_model(model_id)
    state["status"] = "ready"
    return model


def synthesize(model, text: str, ref_audio_path: str, ref_text: str) -> bytes:
    from mlx_audio.tts.generate import generate_audio

    out_dir = tempfile.mkdtemp(prefix="mm-tts-")
    try:
        generate_audio(
            model=model,
            text=text,
            ref_audio=ref_audio_path,
            ref_text=ref_text or None,
            output_path=out_dir,
            file_prefix="out",
            join_audio=True,
            verbose=False,
        )
        # join_audio=True 时是单个文件；防御性兜底取最大的一份。
        files = sorted(glob.glob(os.path.join(out_dir, "*.wav")), key=os.path.getsize, reverse=True)
        if not files:
            raise RuntimeError("engine produced no audio")
        with open(files[0], "rb") as fh:
            return fh.read()
    finally:
        for stale in glob.glob(os.path.join(out_dir, "*")):
            try:
                os.unlink(stale)
            except OSError:
                pass
        try:
            os.rmdir(out_dir)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    model = None  # set in main()

    def log_message(self, fmt, *args):  # 安静模式：错误走 /health 与响应体
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {k: state[k] for k in ("status", "model", "error")})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._json(404, {"error": "not found"})
            return
        if state["status"] != "ready" or self.model is None:
            self._json(503, {"error": f"engine not ready ({state['status']})"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", "")).strip()
            ref_audio = str(req.get("ref_audio_path", "")).strip()
            ref_text = str(req.get("ref_text", "") or "").strip()
            if not text:
                self._json(400, {"error": "text is required"})
                return
            if not ref_audio or not os.path.isfile(ref_audio):
                self._json(400, {"error": "ref_audio_path does not exist"})
                return
            with generate_lock:
                started = time.time()
                wav = synthesize(self.model, text, ref_audio, ref_text)
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(wav)))
            self.send_header("x-generation-ms", str(int((time.time() - started) * 1000)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as exc:  # noqa: BLE001 — 边界进程，任何错误都转给 worker
            traceback.print_exc()
            self._json(500, {"error": str(exc)[:500]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0, help="0 = 随机端口，打印到 stdout 供 worker 读取")
    parser.add_argument("--model", default=os.environ.get("STUDIO_TTS_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    port = server.server_address[1]
    print(f"MAKEMOVIE_TTS_PORT={port}", flush=True)

    def boot():
        try:
            Handler.model = load_engine(args.model)
        except Exception as exc:  # noqa: BLE001
            state["status"] = "error"
            state["error"] = f"{exc}"[:500]
            traceback.print_exc()

    threading.Thread(target=boot, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
