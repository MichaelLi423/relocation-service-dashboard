import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const product = '搬迁服务工作台';
const executable = join(process.cwd(), 'out', `${product}-darwin-${process.arch}`, `${product}.app`, 'Contents', 'MacOS', product);
test.skip(!existsSync(executable), '先运行 npm run e2e:build，使用当前源码的真实 Electron 产物');

async function createProject(page: Page, index: number): Promise<void> {
  await page.getByRole('button', { name: '新建搬迁项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建搬迁项目' });
  await dialog.getByLabel(/客户名称/).fill(`显示微调示例客户 ${index}`);
  await dialog.getByLabel(/^ECC/).fill(`POLISH-DEMO-${index}`);
  await dialog.getByLabel(/区域/).selectOption('East');
  await dialog.getByLabel(/合同 USD 含税金额/).fill('12000');
  await dialog.getByRole('button', { name: '正式进单', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.queue-table-wrap')).toHaveAttribute('aria-busy', 'false');
}

test('正式工作台保留模块顺序，项目操作、弹层焦点、滚动与减少动效保持可用', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'rw-subtle-polish-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: root } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('heading', { name: '把每一次搬迁，推进得更稳' }).waitFor();
    await createProject(page, 1);
    await createProject(page, 2);

    for (const width of [1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const layout = await page.evaluate(() => {
        const selectors = ['.metrics', '.lifecycle', '.reminder-panel', '.project-workspace', '#project-queue'];
        const nodes = selectors.map((selector) => document.querySelector<HTMLElement>(selector)!);
        return {
          order: nodes.every((node, index) => index === 0 || Boolean(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
          overlap: nodes.some((node, index) => index > 0 && nodes[index - 1].getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          topbarPosition: getComputedStyle(document.querySelector('.topbar')!).position,
        };
      });
      expect(layout).toEqual({ order: true, overlap: false, horizontalOverflow: false, topbarPosition: 'sticky' });
      await page.screenshot({ path: testInfo.outputPath(`formal-workbench-${width}.png`), fullPage: true });
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '项目队列', exact: true }).click();
      const queue = page.locator('#project-queue');
      await expect(queue).toBeFocused();
      expect(await queue.evaluate((node) => node.getBoundingClientRect().top >= document.querySelector('.topbar')!.getBoundingClientRect().bottom - 1)).toBe(true);
    }

    const rows = page.getByRole('grid', { name: '项目队列' }).getByRole('row').filter({ has: page.getByText(/^显示微调示例客户/) });
    await expect(rows).toHaveCount(2);
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    expect(await rows.nth(1).evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');

    const record = page.locator('.command').getByRole('button', { name: '快速记录', exact: true });
    await record.hover();
    const resting = await record.boundingBox();
    await page.mouse.down();
    try {
      expect(await record.evaluate((node) => getComputedStyle(node).transform)).toBe('none');
      expect(await record.boundingBox()).toEqual(resting);
    } finally {
      // Release outside the button: inspect pressed styling without opening another layer.
      await page.mouse.move(5, 5);
      await page.mouse.up();
    }
    const disabled = page.getByRole('button', { name: '下一页', exact: true }).last();
    await expect(disabled).toBeDisabled();
    expect(await disabled.evaluate((node) => ({ opacity: getComputedStyle(node).opacity, shadow: getComputedStyle(node).boxShadow }))).toEqual({ opacity: '1', shadow: 'none' });

    for (const width of [820, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const opener = page.getByRole('button', { name: '编辑项目资料', exact: true });
      await opener.scrollIntoViewIfNeeded();
      await opener.focus();
      const before = await page.evaluate(() => ({ y: scrollY, width: document.querySelector('.page')!.getBoundingClientRect().width }));
      await opener.click();
      const dialog = page.getByRole('dialog', { name: '编辑项目资料' });
      if (width === 820) {
        // Slow the finite fade to 10% for inspection; it must not move the form or delay focus.
        const frames = await dialog.evaluate(async (node) => {
          const animation = node.closest('.overlay')!.getAnimations()[0];
          if (!animation) throw new Error('弹层应有可检查的短时淡入');
          animation.playbackRate = .1;
          const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
          await animation.finished;
          return keyframes.map((frame) => ({ opacity: frame.opacity, transform: frame.transform ?? 'none' }));
        });
        expect(frames).toEqual([{ opacity: '0', transform: 'none' }, { opacity: '1', transform: 'none' }]);
      }
      await expect(dialog.getByLabel(/客户名称/)).toBeFocused();
      const layer = await dialog.evaluate((node) => {
        const head = node.querySelector('.layer-head')!.getBoundingClientRect();
        const body = node.querySelector('.layer-body')!;
        return { rootOverflow: getComputedStyle(document.documentElement).overflowY, pageWidth: document.querySelector('.page')!.getBoundingClientRect().width,
          headTop: head.top, headBottom: head.bottom, bodyOverflow: getComputedStyle(body).overflowY,
          overlayAnimation: getComputedStyle(node.closest('.overlay')!).animationDuration };
      });
      expect(layer.rootOverflow).toBe('hidden');
      expect(layer.pageWidth).toBe(before.width);
      expect(layer.headTop).toBeGreaterThanOrEqual(0);
      expect(layer.headBottom).toBeLessThan(800);
      expect(layer.bodyOverflow).toBe('auto');
      expect(layer.overlayAnimation).toBe('0.16s');
      await dialog.locator('.layer-body').evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const headerTop = await dialog.locator('.layer-head').evaluate((node) => node.getBoundingClientRect().top);
      expect(headerTop).toBe(layer.headTop);
      const last = dialog.locator('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])').last();
      await last.focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: '保存项目资料', exact: true })).toBeFocused();
      await page.mouse.move(width - 8, 400);
      await page.mouse.wheel(0, 600);
      expect(await page.evaluate(() => scrollY)).toBe(before.y);
      await page.screenshot({ path: testInfo.outputPath(`project-dialog-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(before.y);
    }

    await page.getByRole('button', { name: '编辑项目资料', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑项目资料' });
    await edit.getByLabel(/^项目备注/).fill('仅用于隔离验证的备注');
    await page.keyboard.press('Escape');
    const discard = page.getByRole('alertdialog');
    await expect(discard.getByRole('button', { name: '继续编辑' })).toBeFocused();
    await discard.getByRole('button', { name: '继续编辑' }).click();
    await expect(edit.getByLabel(/^项目备注/)).toHaveValue('仅用于隔离验证的备注');
    await edit.getByRole('button', { name: '保存项目资料', exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByLabel('项目备注', { exact: true })).toContainText('仅用于隔离验证的备注');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '编辑项目资料', exact: true }).click();
    const reduced = page.getByRole('dialog', { name: '编辑项目资料' });
    await expect(reduced.getByLabel(/客户名称/)).toBeFocused();
    expect(await reduced.evaluate((node) => getComputedStyle(node.closest('.overlay')!).animationName)).toBe('none');
    expect(await reduced.getByRole('button', { name: '关闭', exact: true }).evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
    await page.keyboard.press('Escape');
    await expect(reduced).toBeHidden();
    await page.setViewportSize({ width: 820, height: 768 });
    const addressEntry = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '序列号地址更新', exact: true });
    await addressEntry.click();
    const drawer = page.getByRole('dialog', { name: '序列号地址更新' });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((node) => ({ width: node.getBoundingClientRect().width <= innerWidth, overflow: getComputedStyle(node.querySelector('.layer-body')!).overflowY }))).toEqual({ width: true, overflow: 'auto' });
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(addressEntry).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
