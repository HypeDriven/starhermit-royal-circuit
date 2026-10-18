// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and plays the human seat with the game's real keyboard controls (Enter rolls the
// die, a focused float-picker button moves a float), so the die tumbles, floats hop and capture/crown
// bursts fire while the lanterns, festoon lights and embers animate; a finished round is retried (no reloads).
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.active', { state: 'visible', timeout: 20000 });
  await page.locator('#chip-settings').click();
  await page.waitForFunction(() => !document.getElementById('overlay-settings').hidden);
  await page.locator('#tab-graphics').click();
  await page.waitForSelector('#gfx-preset', { state: 'visible' });
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('gl').dataset.gfxPreset === p, preset);
  await page.locator('#settings-close').click();
  await page.waitForFunction(() => document.getElementById('overlay-settings').hidden);
}

async function press(page, locator) {
  await locator.focus();
  await page.keyboard.press('Enter');
}

async function startStage(page) {
  await page.locator('#card-journey').click();
  await page.waitForSelector('#screen-journey.active', { state: 'visible' });
  await press(page, page.locator('#journey-grid .stage-cell').first());
  await page.waitForSelector('#screen-setup.active', { state: 'visible' });
  await press(page, page.locator('#setup-start'));
  await page.waitForSelector('#screen-game.active', { state: 'visible' });
}

async function step(page) {
  const a = await page.evaluate(() => {
    const pk = document.getElementById('float-picker');
    const roll = document.getElementById('btn-roll');
    const pass = document.getElementById('btn-pass');
    return {
      over: !document.getElementById('overlay-results').hidden,
      picker: pk && !pk.hidden ? pk.querySelectorAll('button').length : 0,
      act: !!(roll && !roll.disabled) || !!(pass && !pass.hidden && !pass.disabled),
    };
  });
  // No reloads while measuring: Retry on the results overlay (and Start if the setup screen shows).
  if (a.over) return press(page, page.locator('#results-retry'));
  if (await page.locator('#screen-setup.active').count()) return press(page, page.locator('#setup-start'));
  if (a.picker) {
    await page.locator('#float-picker button').last().focus();
    await page.keyboard.press('Enter');
  } else if (a.act) await page.keyboard.press('Enter');
}

export async function start(page) {
  await startStage(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(200).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
