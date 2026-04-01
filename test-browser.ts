#!/usr/bin/env bun
import { webkit } from "playwright";

async function test() {
  console.log("Launching WebKit (Safari engine)...");
  const browser = await webkit.launch({ headless: false });
  const page = await browser.newPage({ locale: "it-IT" });

  console.log("Test 1: Google...");
  try {
    await page.goto("https://www.google.com", { timeout: 15000 });
    console.log("  ✓ Google loaded.");
  } catch (e) {
    console.log("  ✗ FAILED:", String(e).slice(0, 120));
  }

  console.log("Test 2: Esselunga login page...");
  try {
    await page.goto(
      "https://account.esselunga.it/area-utenti/applicationCheck?appName=spesaOnLine&daru=https%3A%2F%2Fspesaonline.esselunga.it%3A443%2Fcommerce%2Flogin%2Fspesaonline%2Fstore%2Fhome%3F&loginType=light",
      { timeout: 30000 }
    );
    console.log("  ✓ Login page loaded. URL:", page.url());
  } catch (e) {
    console.log("  ✗ FAILED:", String(e).slice(0, 120));
  }

  console.log("Test 3: Esselunga store...");
  try {
    await page.goto("https://spesaonline.esselunga.it", { waitUntil: "commit", timeout: 30000 });
    console.log("  ✓ Store responded. URL:", page.url());
  } catch (e) {
    console.log("  ✗ FAILED:", String(e).slice(0, 120));
  }

  await browser.close();
  console.log("\nDone.");
}

test().catch(console.error);
