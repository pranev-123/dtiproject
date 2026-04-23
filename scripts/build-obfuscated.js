const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { minify: minifyHtml } = require('html-minifier-terser');
const { minify: minifyJs } = require('terser');
const CleanCSS = require('clean-css');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const SOURCE_PUBLIC = path.join(ROOT, 'public');
const SOURCE_ASSETS = path.join(ROOT, 'assets');
const OUT_ROOT = path.join(ROOT, 'build');
const OUT_PUBLIC = path.join(OUT_ROOT, 'public');
const OUT_ASSETS = path.join(OUT_ROOT, 'assets');

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function removeDir(dir) {
  if (fs.existsSync(dir)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function processFile(srcPath, destPath) {
  const ext = path.extname(srcPath).toLowerCase();
  const raw = await fsp.readFile(srcPath);

  if (ext === '.html') {
    const html = raw.toString('utf8');
    const minified = await minifyHtml(html, {
      collapseWhitespace: true,
      removeComments: true,
      minifyCSS: true,
      minifyJS: true,
      removeRedundantAttributes: true,
      removeOptionalTags: false,
      keepClosingSlash: true,
    });
    await fsp.writeFile(destPath, minified, 'utf8');
    return;
  }

  if (ext === '.css') {
    const css = raw.toString('utf8');
    const out = new CleanCSS({ level: 2 }).minify(css);
    if (out.errors && out.errors.length) throw new Error(out.errors.join('\n'));
    await fsp.writeFile(destPath, out.styles, 'utf8');
    return;
  }

  if (ext === '.js') {
    const js = raw.toString('utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(js, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.25,
      deadCodeInjection: false,
      stringArray: true,
      stringArrayThreshold: 0.75,
      identifierNamesGenerator: 'hexadecimal',
      transformObjectKeys: true,
    }).getObfuscatedCode();
    const terserOut = await minifyJs(obfuscated, {
      compress: true,
      mangle: true,
      format: { comments: false },
    });
    await fsp.writeFile(destPath, terserOut.code || obfuscated, 'utf8');
    return;
  }

  await fsp.copyFile(srcPath, destPath);
}

async function copyTree(srcRoot, destRoot) {
  if (!fs.existsSync(srcRoot)) return;
  await ensureDir(destRoot);
  const entries = await fsp.readdir(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcRoot, entry.name);
    const destPath = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath);
      continue;
    }
    await processFile(srcPath, destPath);
  }
}

async function run() {
  await removeDir(OUT_ROOT);
  await ensureDir(OUT_PUBLIC);
  await ensureDir(OUT_ASSETS);
  await copyTree(SOURCE_PUBLIC, OUT_PUBLIC);
  await copyTree(SOURCE_ASSETS, OUT_ASSETS);
  console.log('Obfuscated production build created at /build');
}

run().catch((err) => {
  console.error('build-obfuscated failed:', err);
  process.exit(1);
});
