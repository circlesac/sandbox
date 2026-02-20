const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const { version } = require("../package.json");
const REPO = "circlesac/sandbox";

const PLATFORMS = {
  "darwin-x64": { artifact: "sandbox-darwin-amd64", ext: ".tar.gz" },
  "darwin-arm64": { artifact: "sandbox-darwin-arm64", ext: ".tar.gz" },
  "linux-x64": { artifact: "sandbox-linux-amd64", ext: ".tar.gz" },
  "linux-arm64": { artifact: "sandbox-linux-arm64", ext: ".tar.gz" },
};

async function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
  });
}

async function main() {
  const platform = `${process.platform}-${process.arch}`;
  const info = PLATFORMS[platform];
  if (!info) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  const { artifact, ext } = info;
  const url = `https://github.com/${REPO}/releases/download/v${version}/${artifact}${ext}`;
  const nativeDir = path.join(__dirname, "native");
  fs.mkdirSync(nativeDir, { recursive: true });

  const data = await download(url);
  const tmp = path.join(nativeDir, `tmp${ext}`);
  fs.writeFileSync(tmp, data);
  execSync(`tar xzf "${tmp}"`, { cwd: nativeDir });
  fs.unlinkSync(tmp);
  fs.chmodSync(path.join(nativeDir, "sandbox"), 0o755);
}

module.exports = main();
