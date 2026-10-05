"""MakeMovie 内嵌语音引擎安装器（r10 音频体系·路径 2 的下载引导后端）。

分三阶段把引擎装进引擎目录（var/tts-engine）：
  1. venv    建 Python 3.12 虚拟环境 + pip 装 mlx-audio（清华镜像）
  2. model   snapshot_download 8bit 模型 ~2.4GB（hf-mirror 镜像，HF_HOME 隔离）
  3. done    写 model.ready（内容=快照绝对路径）——worker 见路径即用

进度落 install-state.json（含 pid，API 用它判断安装进程是否还活着）；
任何阶段失败都把原始错误写进 state，UI 照读。

用法：python install_tts_engine.py --engine-dir /path/to/var/tts-engine
要求：python3（3.10+）；无网络时 venv 阶段直接报错（镜像也到不了）。
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
HF_ENDPOINT = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")

# Apple Silicon 上 mlx 才有轮子；其他平台直接判不支持，别让 pip 白跑。
def python_candidates():
    if sys.platform == "darwin" and os.uname().machine == "arm64":
        return ["/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.13", "/usr/bin/python3"]
    return []


def write_state(engine_dir: Path, phase: str, detail: str = "", error: str | None = None):
    payload = {
        "phase": phase,
        "detail": detail,
        "error": error,
        "pid": os.getpid(),
        "updatedAt": int(time.time() * 1000),
        "modelId": MODEL_ID,
    }
    (engine_dir / "install-state.json").write_text(json.dumps(payload, ensure_ascii=False))


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.stat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def phase_venv(engine_dir: Path) -> str:
    for candidate in python_candidates():
        if not Path(candidate).exists():
            continue
        venv_bin = engine_dir / "venv"
        result = subprocess.run(
            [candidate, "-m", "venv", str(venv_bin)],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            continue
        pip = str(venv_bin / "bin" / "pip")
        install = subprocess.run(
            [pip, "install", "--quiet", "mlx-audio", "-i", PIP_INDEX],
            capture_output=True, text=True, timeout=1800,
        )
        if install.returncode != 0:
            raise RuntimeError(f"pip install mlx-audio 失败: {(install.stderr or install.stdout)[-800:]}")
        return f"venv 就绪（{candidate}）"
    raise RuntimeError("找不到可用的 Python（需要 macOS Apple Silicon + python3，建议 brew install python@3.12）")


def phase_model(engine_dir: Path) -> str:
    hf_home = engine_dir / "hf"
    env = {**os.environ, "HF_HOME": str(hf_home), "HF_ENDPOINT": HF_ENDPOINT}
    # 进度线程：每 2s 把已下载字节数写进 state（UI 显示 MB 数）。
    stop = {"flag": False}

    def progress():
        while not stop["flag"]:
            write_state(engine_dir, "model", f"已下载 {dir_size(hf_home) / 1e9:.2f} GB")
            time.sleep(2)

    import threading

    thread = threading.Thread(target=progress, daemon=True)
    thread.start()
    try:
        sys.path.insert(0, str(engine_dir / "venv" / "lib"))
        # 用 venv 的 python 子进程跑下载，避免 import 污染本进程。
        snippet = (
            "from huggingface_hub import snapshot_download;"
            f"print(snapshot_download('{MODEL_ID}'))"
        )
        result = subprocess.run(
            [str(engine_dir / "venv" / "bin" / "python"), "-c", snippet],
            capture_output=True, text=True, timeout=7200, env=env,
        )
        if result.returncode != 0:
            raise RuntimeError(f"模型下载失败: {(result.stderr or result.stdout)[-800:]}")
        snapshot = result.stdout.strip().splitlines()[-1]
        (engine_dir / "model.ready").write_text(snapshot + "\n")
        return f"模型就绪（{(dir_size(hf_home) / 1e9):.2f} GB）"
    finally:
        stop["flag"] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", required=True)
    args = parser.parse_args()
    engine_dir = Path(args.engine_dir).expanduser()
    engine_dir.mkdir(parents=True, exist_ok=True)
    try:
        write_state(engine_dir, "venv", "创建 Python 环境…")
        detail = phase_venv(engine_dir)
        write_state(engine_dir, "model", "开始下载模型…")
        detail += "；" + phase_model(engine_dir)
        write_state(engine_dir, "done", detail)
    except Exception as exc:  # noqa: BLE001 — 错误必须落到 state 给 UI 读
        write_state(engine_dir, "error", "", error=str(exc)[:800])
        sys.exit(1)


if __name__ == "__main__":
    main()
