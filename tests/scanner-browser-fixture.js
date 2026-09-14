import fs from "node:fs";
const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/qr-codes.json", import.meta.url), "utf8"));

// Feed real QR images through a real canvas MediaStream; only the camera device is simulated.
export async function installCamera(context) {
  await context.addInitScript((fixtures) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 640;
    const ctx = canvas.getContext("2d");
    const camera = window.testCamera = { calls: 0, tracks: [], constraints: [], error: null, defer: false, resolveStart: null, code: null };
    camera.draw = (code) => { camera.code = code; paint(); };
    function paint() {
      ctx.fillStyle = "#e8e8e8"; ctx.fillRect(0, 0, 640, 640);
      ctx.fillStyle = "white"; ctx.fillRect(70, 70, 500, 500);
      const matrix = fixtures[camera.code];
      if (!matrix) return;
      const scale = Math.floor(420 / matrix.length), offset = Math.floor((640 - matrix.length * scale) / 2);
      ctx.fillStyle = "black";
      matrix.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === "1") ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale); }));
    }
    paint(); setInterval(paint, 100);
    camera.getUserMedia = async (constraints) => {
      camera.calls++; camera.constraints.push(constraints);
      if (camera.error) throw new DOMException("simulated camera error", camera.error);
      if (camera.defer) await new Promise((resolve) => { camera.resolveStart = resolve; });
      const stream = canvas.captureStream(10); camera.tracks.push(...stream.getTracks()); return stream;
    };
    // Replace the accessor result itself: WebKit can otherwise expose a fresh native object.
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: camera.getUserMedia } });
  }, fixtures);
}

export async function showQr(page, code) {
  await page.evaluate((code) => window.testCamera.draw(code), code);
}

export async function scanAndConfirm(page, code) {
  await showQr(page, code);
  try { await page.locator("#scanConfirmation").getByText(code, { exact: true }).waitFor(); }
  catch (error) {
    const observed = await page.evaluate(() => ({ candidate: document.getElementById("scanCode")?.textContent, phase: document.getElementById("scanPhase")?.textContent, status: document.getElementById("scanStatus")?.textContent, frame: window.testCamera?.code }));
    throw new Error(`Expected scan ${code}; observed ${JSON.stringify(observed)}`, { cause: error });
  }
  await page.locator("#scanConfirm").click();
}

export async function openIssueScanner(page) {
  if (!await page.evaluate(() => navigator.mediaDevices.getUserMedia === window.testCamera?.getUserMedia)) throw new Error("Camera fixture is not installed; refusing to request a real camera.");
  // A fresh camera session must not recognize the previous test's still-visible coupon.
  await showQr(page, null);
  const empty = page.locator("#issueEmptyScan");
  await (await empty.isVisible() ? empty : page.locator("#scanOpen")).click();
}
