#!/usr/bin/env node
// scripts/dev-harness.mjs
//
// Development harness for visual iteration on the cosmos-gl-graph UI.
// Launches a headless Chromium instance, navigates to the running Vite dev
// server, captures a screenshot, and prints a small JSON report to stdout.
//
// This script is development tooling only. It is never imported from src/ or
// ui/src/ and it does NOT run as part of `npm run test`.
//
// Usage:
//   1. In one terminal: npm run dev:ui          (Vite on :5173)
//   2. In another:      kiro-learn start        (collector on :21100)
//   3. In a third:      node scripts/dev-harness.mjs
//
// Environment:
//   KIRO_DEV_URL   Override the URL to visit (default http://127.0.0.1:5173)

import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const VITE_URL = process.env.KIRO_DEV_URL ?? 'http://127.0.0.1:5173';
const OUT_DIR = '.kiro-dev';
const CANVAS_SELECTOR = '[data-testid="cosmos-canvas"]';
const LABEL_SELECTOR = '[data-testid="cosmos-label"]';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(VITE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 15_000 });
  // Wait through data fetch + settle timer + fitView buffer.
  await page.waitForTimeout(16_000);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await page.screenshot({ path: `${OUT_DIR}/screenshot.png`, fullPage: false });

  const stats = await page.evaluate(
    ({ canvasSelector, labelSelector }) => {
      const container = document.querySelector(canvasSelector);
      const canvas = container?.querySelector('canvas') ?? null;
      const labels = Array.from(document.querySelectorAll(labelSelector));
      const visibleLabelCount = labels.filter(
        (el) => getComputedStyle(el).visibility !== 'hidden',
      ).length;
      return {
        canvasWidth: canvas ? canvas.clientWidth : null,
        canvasHeight: canvas ? canvas.clientHeight : null,
        visibleLabelCount,
        totalLabelCount: labels.length,
      };
    },
    { canvasSelector: CANVAS_SELECTOR, labelSelector: LABEL_SELECTOR },
  );

  console.log(JSON.stringify({ stats, consoleErrors }, null, 2));
} finally {
  await browser.close();
}
