#!/usr/bin/env node
/**
 * 产品页收录护栏：website/ 是纯静态站，没有任何构建步骤会读这些字段，
 * 所以它们写错、写旧、被哪次改动删掉时，唯一的反应是「Google 不收了」——
 * 而那要几周后才看得见。这个闸门把它们全部当场判掉。
 *
 * 检查的是结构与一致性，不是文案：
 *   双语页各自的 title/description/canonical；hreflang 三件套必须绝对 URL 且两页互指一致；
 *   JSON-LD 必须能解析，且 softwareVersion 等于 package.json 的 version（发版忘同步就在这里红）；
 *   og/twitter 图必须是真的本地文件，声明的宽高必须等于 PNG 实际像素；
 *   sitemap 的每条 <loc> 落到磁盘上都得存在，且和 hreflang 指向同一组 URL；
 *   robots.txt 的 Sitemap 行、llms.txt 里两条产品页地址。
 *
 * 只在本地跑（CI 的 Website guard、发布前手动）。零依赖、零网络。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'website');
const ORIGIN = 'https://dreamofxm.github.io/makemovie';

const fail = [];
const note = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); return ok; };

const PAGES = [
  { file: join(SITE, 'index.html'), url: `${ORIGIN}/`, lang: 'en', ogLocale: 'en_US' },
  { file: join(SITE, 'zh', 'index.html'), url: `${ORIGIN}/zh/`, lang: 'zh-Hans', ogLocale: 'zh_CN' },
];

/** 公开 URL → 磁盘文件；GitHub Pages 把 /x/  served 成 /x/index.html。 */
function diskFor(url) {
  if (!url.startsWith(`${ORIGIN}/`)) return null;
  const rel = url.slice(ORIGIN.length + 1);
  if (rel === '') return join(SITE, 'index.html');
  const direct = join(SITE, rel);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  if (rel.endsWith('/')) return join(SITE, rel, 'index.html');
  return join(SITE, rel);
}

function pngSize(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== sig) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 读 RIFF/WEBP 的块布局：fourcc + 实际尺寸 + 是否无损（VP8L）。 */
function webpInfo(buf) {
  if (buf.subarray(0, 4).toString() !== 'RIFF' || buf.subarray(8, 12).toString() !== 'WEBP') return null;
  let off = 12;
  let lossless = false;
  let size = null;
  while (off + 8 <= buf.length) {
    const fourcc = buf.subarray(off, off + 4).toString();
    const len = buf.readUInt32LE(off + 4);
    const data = off + 8;
    if (fourcc === 'VP8L') {
      lossless = true;
      const v = buf.readUInt32LE(data + 1);
      size = { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    } else if (fourcc === 'VP8 ') {
      size = { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    } else if (fourcc === 'VP8X') {
      size = { width: 1 + (buf[data + 4] | (buf[data + 5] << 8) | (buf[data + 6] << 16)),
               height: 1 + (buf[data + 7] | (buf[data + 8] << 8) | (buf[data + 9] << 16)) };
    }
    off = data + len + (len % 2);
  }
  if (!size) return null;
  return { ...size, lossless };
}

/** 页面内相对引用（assets/x.webp、../assets/x.png）与站内绝对 URL 都解析到磁盘。 */
function siteFile(pageFile, ref) {
  if (!ref) return null;
  if (ref.startsWith(`${ORIGIN}/`)) return diskFor(ref);
  if (/^https?:\/\//.test(ref)) return null;
  return resolve(dirname(pageFile), ref.split('?')[0].split('#')[0]);
}

const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
const hreflangSet = new Map();

for (const page of PAGES) {
  const label = page.url.replace(ORIGIN, 'website') || 'website/';
  if (!existsSync(page.file)) { check(false, `${label}: 文件不存在`); continue; }
  const html = readFileSync(page.file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>') + 7);

  check(/<html lang="[^"]+">/.test(head), `${label}: 缺 <html lang>`);

  const titles = [...head.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/g)];
  check(titles.length === 1, `${label}: <title> 应恰好 1 个，实际 ${titles.length}`);
  const title = (titles[0]?.[1] ?? '').trim();
  check(title.includes('MakeMovie'), `${label}: title 里没有产品名 MakeMovie`);
  note.push(`${label} title ${[...title].length} 字符: ${title}`);

  const desc = /<meta name="description" content="([^"]*)"/.exec(head)?.[1] ?? '';
  check(desc.length > 40, `${label}: meta description 缺失或过短（${desc.length}）`);
  note.push(`${label} description ${[...desc].length} 字符`);

  const canonical = attr(/<link rel="canonical"[^>]*>/.exec(head)?.[0] ?? '', 'href');
  check(canonical === page.url, `${label}: canonical=${canonical || '缺'} 与本页公开 URL ${page.url} 不一致`);

  check(!/name="robots"[^>]*noindex/.test(head), `${label}: 出现 noindex`);

  const alts = [...head.matchAll(/<link rel="alternate"[^>]*>/g)]
    .filter((m) => /hreflang=/.test(m[0]))
    .map((m) => ({ lang: attr(m[0], 'hreflang'), href: attr(m[0], 'href') }));
  hreflangSet.set(page.url, alts);

  for (const want of ['en', 'zh-Hans', 'x-default']) {
    check(alts.some((a) => a.lang === want), `${label}: hreflang 缺 ${want}`);
  }
  for (const a of alts) {
    check(/^https:\/\//.test(a.href), `${label}: hreflang ${a.lang} 不是绝对 URL：${a.href}`);
  }
  const selfAlt = alts.find((a) => a.lang === page.lang);
  if (selfAlt) check(selfAlt.href === canonical, `${label}: hreflang ${page.lang} 指 ${selfAlt.href}，canonical 指 ${canonical}`);

  for (const prop of ['og:url', 'og:image', 'og:title', 'og:description', 'og:site_name', 'og:locale']) {
    const tag = new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(head)?.[1] ?? '';
    check(tag !== '', `${label}: 缺 ${prop}`);
    if (prop === 'og:locale') check(tag === page.ogLocale, `${label}: og:locale=${tag}，应为 ${page.ogLocale}`);
    if (prop === 'og:url') check(tag === page.url, `${label}: og:url=${tag} 与本页 URL 不一致`);
  }

  for (const prop of ['og:image', 'twitter:image']) {
    const tag = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`).exec(head)?.[1] ?? '';
    const file = diskFor(tag);
    check(file !== null && existsSync(file), `${label}: ${prop} 指向的本地文件不存在：${tag}`);
    if (file && existsSync(file)) {
      const dims = pngSize(readFileSync(file).subarray(0, 33));
      const w = attr(new RegExp(`<meta property="og:image:width" content="([^"]*)"`).exec(head)?.[0] ?? '', 'content');
      const h = attr(new RegExp(`<meta property="og:image:height" content="([^"]*)"`).exec(head)?.[0] ?? '', 'content');
      check(dims !== null, `${label}: ${prop} 不是可读的 PNG`);
      if (dims) check(String(dims.width) === w && String(dims.height) === h,
        `${label}: og:image 声明 ${w}x${h}，${tag.split('/').pop()} 实测 ${dims.width}x${dims.height}`);
    }
  }

  // twitter:site 只有真实句柄才有意义：空值当占位处理（不判失败，只报未填），
  // 一旦填上就必须是合法句柄——半截句柄和带空格的中文名比不填更容易被卡片渲染成乱码归属。
  const tsite = /<meta name="twitter:site" content="([^"]*)"/.exec(head)?.[1];
  check(tsite !== undefined, `${label}: twitter:site 字段没有占位行`);
  if (tsite) {
    check(/^@[A-Za-z0-9_]{1,15}$/.test(tsite),
      `${label}: twitter:site="${tsite}" 不是合法 X 句柄（@ 开头、至多 15 位字母数字下划线）`);
    note.push(`${label} twitter:site ${tsite}`);
  } else {
    note.push(`${label} twitter:site 未填（空值占位）`);
  }

  // ===== 页面正文：标题层、图片可索引性与链接信誉 =====

  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  check(h1.length === 1, `${label}: <h1> 应恰好 1 个，实际 ${h1.length}`);
  if (h1.length === 1) note.push(`${label} h1: ${h1[0][1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 56)}`);

  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of imgs) {
    const src = attr(tag, 'src');
    check(attr(tag, 'alt').trim() !== '', `${label}: 图片缺 alt（图片搜索与 AI 引用没有文字入口）：${src}`);
    for (const dim of ['width', 'height']) {
      check(attr(tag, dim) !== '', `${label}: 图片缺 ${dim}（加载时撑动版面，CLS 是排名因子）：${src}`);
    }
    const file = siteFile(page.file, src);
    check(file !== null && existsSync(file), `${label}: 图片落不到磁盘：${src}`);
  }

  // 备用档必须是**无损** WebP（VP8L）：截图里的界面文字一旦被有损压缩糊掉，
  // 这张图就没有存在意义了，而小尺寸预览上肉眼看不出来。
  const sources = [...html.matchAll(/<source\b[^>]*>/g)].map((m) => m[0]).filter((t) => /type="image\/webp"/.test(t));
  check(sources.length === imgs.length, `${label}: ${imgs.length} 张图只有 ${sources.length} 个 WebP 备用档`);
  for (const tag of sources) {
    const srcset = attr(tag, 'srcset');
    const file = siteFile(page.file, srcset);
    check(file !== null && existsSync(file), `${label}: WebP 备用档不存在：${srcset}`);
    if (!file || !existsSync(file)) continue;
    const info = webpInfo(readFileSync(file));
    check(info !== null, `${label}: ${srcset} 不是可解析的 WebP`);
    if (!info) continue;
    check(info.lossless, `${label}: ${srcset} 不是无损 WebP（VP8L）——有损档会把截图里的界面文字压糊`);
    const pngFile = siteFile(page.file, srcset.replace(/\.webp$/, '.png'));
    const dims = pngFile && existsSync(pngFile) ? pngSize(readFileSync(pngFile).subarray(0, 33)) : null;
    check(dims !== null, `${label}: ${srcset} 找不到同名 PNG，无法核对像素`);
    if (dims) check(dims.width === info.width && dims.height === info.height,
      `${label}: ${srcset.split('/').pop()} 是 ${info.width}x${info.height}，同名 PNG 是 ${dims.width}x${dims.height}（备用档尺寸必须一致）`);
  }

  // 自家仓库链接不许挂 nofollow：那是产品与代码主页之间唯一的实体级互指。
  for (const m of html.matchAll(/<a\b[^>]*href="[^"]*"[^>]*>/g)) {
    if (!/github\.com\/DreamOfXM/.test(m[0])) continue;
    check(!/rel="[^"]*nofollow/.test(m[0]), `${label}: 自家 GitHub 链接挂了 nofollow：${attr(m[0], 'href')}`);
  }

  const describedby = attr(/<link rel="describedby"[^>]*>/.exec(head)?.[0] ?? '', 'href');
  check(describedby === `${ORIGIN}/llms.txt`, `${label}: rel=describedby=${describedby || '缺'}，应指 ${ORIGIN}/llms.txt`);
  check(/<a\b[^>]*href="[^"]*llms\.txt"/.test(html), `${label}: 页面上没有指向 llms.txt 的可点链接，AI 爬虫不会自己猜路径`);

  const gsv = /<meta name="google-site-verification" content="([^"]*)"/.exec(head)?.[1];
  if (gsv === undefined) note.push(`${label} google-site-verification 无该行（改用文件验证时不需要）`);
  else if (gsv === '') note.push(`${label} google-site-verification 未填（空值占位）`);
  else note.push(`${label} google-site-verification 已填（${gsv.length} 字符）`);

  const tcreator = /<meta name="twitter:creator" content="([^"]*)"/.exec(head)?.[1] ?? '';
  if (tcreator && tsite) check(tcreator === tsite, `${label}: twitter:creator=${tcreator} 与 twitter:site=${tsite} 不是同一个号——卡片会把作者归到别人`);

  const blocks = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  check(blocks.length === 1, `${label}: JSON-LD 应恰好 1 块，实际 ${blocks.length}`);
  if (blocks.length === 1) {
    let data = null;
    try { data = JSON.parse(blocks[0][1]); } catch (e) { check(false, `${label}: JSON-LD 解析失败 ${e.message}`); }
    if (data) {
      check(data['@context'] === 'https://schema.org', `${label}: JSON-LD @context 不是 https://schema.org`);
      const graph = data['@graph'] ?? [];
      const app = graph.find((g) => g['@type'] === 'SoftwareApplication');
      check(Boolean(app), `${label}: JSON-LD 里没有 SoftwareApplication`);
      check(graph.some((g) => g['@type'] === 'Organization'), `${label}: JSON-LD 里没有 Organization`);
      // 全局实体（组织、站点）两页必须用同一个 @id：各建一个节点，Google 会当成两家。
      const org = graph.find((g) => g['@type'] === 'Organization');
      if (org) {
        check(org['@id'] === `${ORIGIN}/#organization`,
          `${label}: Organization @id=${org['@id']}，双语页应共用站点根节点 ${ORIGIN}/#organization`);
        const sameAs = Array.isArray(org.sameAs) ? org.sameAs : [];
        for (const s of ['https://github.com/DreamOfXM/makemovie', 'https://github.com/DreamOfXM', 'https://x.com/DreamOfXM']) {
          check(sameAs.includes(s), `${label}: Organization.sameAs 缺 ${s}（实体图谱断一条，主页之间互不承认）`);
        }
      }
      const imgNode = graph.find((g) => g['@type'] === 'ImageObject');
      check(Boolean(imgNode), `${label}: JSON-LD 里没有 ImageObject（图片授权口径与图片搜索入口）`);
      if (imgNode) {
        const file = diskFor(String(imgNode.contentUrl ?? ''));
        check(file !== null && existsSync(file), `${label}: ImageObject contentUrl 落不到磁盘：${imgNode.contentUrl}`);
        const dims = file && existsSync(file) ? pngSize(readFileSync(file).subarray(0, 33)) : null;
        check(dims !== null && dims.width === imgNode.width && dims.height === imgNode.height,
          `${label}: ImageObject 声明 ${imgNode.width}x${imgNode.height}，实测 ${dims ? `${dims.width}x${dims.height}` : '读不到'}`);
        check(String(imgNode.license ?? '').includes('Apache-2.0'), `${label}: ImageObject 没有 license，引用方拿不到授权口径`);
        check(String(imgNode.creditText ?? '') !== '', `${label}: ImageObject 没有 creditText`);
        const pageNode = graph.find((g) => g['@type'] === 'WebPage');
        check(String(pageNode?.primaryImageOfPage?.['@id'] ?? '').endsWith('#hero-image'),
          `${label}: WebPage.primaryImageOfPage 没指向那个 ImageObject 节点`);
      }
      if (app) {
        const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
        check(app.softwareVersion === version,
          `${label}: JSON-LD softwareVersion=${app.softwareVersion}，package.json=${version}（发版后忘同步）`);
        check(/^\d{4}-\d{2}-\d{2}$/.test(String(app.dateModified)), `${label}: dateModified 不是 YYYY-MM-DD`);
        check(Array.isArray(app.featureList) && app.featureList.length >= 6, `${label}: featureList 少于 6 条`);
        check(String(app.license ?? '').includes('Apache-2.0'), `${label}: license 不是 Apache-2.0`);
      }
    }
  }
}

for (const [url, alts] of hreflangSet) {
  for (const a of alts) {
    if (a.lang === 'x-default') continue;
    const other = hreflangSet.get(a.href);
    check(other !== undefined, `hreflang ${a.href} 不在已知的双语页集合里`);
    if (other) check(other.some((o) => o.lang === a.lang), `${url} 声明 ${a.lang}→${a.href}，但那一页没有互指回来`);
  }
}

const robots = existsSync(join(SITE, 'robots.txt')) ? readFileSync(join(SITE, 'robots.txt'), 'utf8') : '';
check(/User-agent:\s*\*/.test(robots), 'robots.txt: 没有 User-agent: * 段');
check(!/Disallow:\s*\/\s*$/m.test(robots), 'robots.txt: 有 Disallow: / —— 整站被封');
const sitemapLine = /^Sitemap:\s*(\S+)/m.exec(robots)?.[1] ?? '';
check(sitemapLine === `${ORIGIN}/sitemap.xml`, `robots.txt: Sitemap 行=${sitemapLine || '缺'}，应为 ${ORIGIN}/sitemap.xml`);

const sitemap = existsSync(join(SITE, 'sitemap.xml')) ? readFileSync(join(SITE, 'sitemap.xml'), 'utf8') : '';
check(sitemap.includes('http://www.sitemaps.org/schemas/sitemap/0.9'), 'sitemap.xml: 缺标准命名空间');
check(sitemap.includes('http://www.w3.org/1999/xhtml'), 'sitemap.xml: 缺 xhtml 命名空间（语言互指用不了）');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check(locs.length === PAGES.length, `sitemap.xml: <loc> ${locs.length} 条，应为 ${PAGES.length} 条`);
for (const loc of locs) {
  const file = diskFor(loc);
  check(file !== null && existsSync(file), `sitemap.xml: <loc> 落不到磁盘：${loc}`);
  check(hreflangSet.has(loc), `sitemap.xml: <loc> ${loc} 与页面 hreflang 不是同一组 URL`);
}
for (const [url, alts] of hreflangSet) {
  for (const a of alts) check(locs.includes(a.href), `${url} 的 hreflang 目标 ${a.href} 不在 sitemap 里`);
}

const llms = existsSync(join(SITE, 'llms.txt')) ? readFileSync(join(SITE, 'llms.txt'), 'utf8') : '';
check(/^# MakeMovie\s/.test(llms), 'llms.txt: 第一行不是 `# MakeMovie`');
for (const page of PAGES) check(llms.includes(page.url), `llms.txt: 没有列出自本页 ${page.url}`);
const llmsLinks = [...llms.matchAll(/https:\/\/[^)\s]+/g)].map((m) => m[0]);
for (const link of llmsLinks.filter((l) => l.startsWith(ORIGIN))) {
  const file = diskFor(link);
  check(file !== null && existsSync(file), `llms.txt: 站内链接落不到磁盘：${link}`);
}

for (const line of note) console.log(`  · ${line}`);
if (fail.length) {
  console.error(`\nwebsite-check: ${fail.length} 条失败`);
  for (const f of fail) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nwebsite-check: 双语页 + robots + sitemap + llms.txt 全过（${PAGES.length} 页）`);
