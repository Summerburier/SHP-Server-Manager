import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
let executablePath = process.env.BROWSER_PATH;
if (!executablePath) {
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* Try the next installed browser. */ }
  }
}
if (!executablePath) throw new Error('请通过 BROWSER_PATH 设置本机 Chromium / Chrome / Edge 可执行文件路径');
const temp = await mkdtemp(join(tmpdir(), 'shp-browser-'));
const game = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, app: '0.2.6', uptimeSec: 400, sockets: 4, rooms: 2, humans: 3, matches: 1, bots: 1, spectators: 0, sessions: 4 })));
let child, browser;
try {
  game.listen(0, '127.0.0.1'); await once(game, 'listening');
  const marker = join(temp, 'action.txt'), token = 'browser-test-long-random-secret-1234';
  const configFile = join(temp, 'config.json');
  await writeFile(configFile, JSON.stringify({ host: { pollIntervalSeconds: 2 }, servers: [{ id: 'main', name: '测试节点 <script>', url: `http://127.0.0.1:${game.address().port}`, actions: { restart: { command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.argv[1], 'done')", marker] } } }] }));
  child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ADMIN_TOKEN: token, CONFIG_FILE: configFile, DATA_DIR: join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => stderr += d);
  const deadline = Date.now() + 10000;
  while (!/http:\/\/127.0.0.1:\d+/.test(output) && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 30));
  const url = /http:\/\/127.0.0.1:\d+/.exec(output)?.[0]; assert(url, stderr || '后端启动超时');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error' && /Content Security Policy|Refused to/.test(entry.text())) errors.push(entry.text()); });
  await page.goto(url);
  const artifacts = resolve(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
  await page.getByLabel('管理密码').waitFor();
  for(const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:2560,height:1440}]) {
    await page.setViewportSize(viewport);
    const alignment=await page.evaluate(()=>{const intro=document.querySelector('.login-intro').getBoundingClientRect(),form=document.querySelector('.login-console').getBoundingClientRect(),radar=document.querySelector('.login-radar').getBoundingClientRect();return {gap:form.left-intro.right,formOffset:form.left-innerWidth/2,radarOffset:innerWidth/2-(radar.left+radar.width/2)};});
    assert(alignment.gap<=100 && alignment.formOffset>=0 && alignment.formOffset<=80,'登录框应靠近中线');
    assert(alignment.radarOffset<=300,'动画应靠近中线');
    await page.screenshot({path:join(artifacts,`login-${viewport.width}x${viewport.height}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({ path: join(artifacts, 'login-desktop.png'), fullPage: true });
  await page.getByLabel('管理密码').fill('wrong-password-at-least-24chars');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('alert').filter({ hasText: '用户名或密码错误' }).waitFor();
  await page.getByLabel('管理密码').fill(token);
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('heading', { name: '运行监控' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '刷新', exact: true }).count(), 0);
  const initialUpdate = await page.locator('.header-actions span').textContent();
  await page.waitForFunction(previous => document.querySelector('.header-actions span')?.textContent !== previous, initialUpdate);
  await page.getByRole('navigation').getByRole('button', { name: '服务' }).click();
  await page.getByRole('heading', { name: '测试节点 <script>' }).waitFor();
  assert(await page.getByRole('button', {name:'启动', exact:true}).isDisabled());
  assert(await page.getByRole('button', {name:'停止', exact:true}).isDisabled());
  assert.equal(await page.locator('.game-monitor').count(), 0);
  assert.equal(await page.locator('.service-card').count(), 1);
  await page.getByRole('button',{name:'＋ 添加服务'}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('项目文件夹').fill('C:/example/project');
  await page.getByLabel('端口',{exact:true}).fill('3100');
  await page.getByRole('button',{name:'添加',exact:true}).click();
  const modalError=page.locator('.notification-card.error').last();
  await modalError.waitFor({state:'visible'});
  assert(await page.locator('.notification-stack').evaluate(el=>getComputedStyle(el).position==='fixed'));
  await modalError.getByRole('button',{name:'关闭通知'}).click();

  assert.equal(await page.getByRole('button',{name:'检查连接'}).count(),0);
  for(const viewport of [{width:1920,height:1080},{width:2560,height:1440},{width:390,height:844}]){await page.setViewportSize(viewport);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(artifacts,`service-modal-${viewport.width}x${viewport.height}.png`),fullPage:true});}
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'取消添加或编辑'}).click();
  const connected=await (await page.request.get(url + '/api/services')).json();
  const gameAddress=new URL(connected.servers[0].url);
  await page.getByRole('button',{name:'＋ 添加服务'}).click();
  await page.getByLabel('服务名称',{exact:true}).fill('弹窗测试服务');
  assert.equal(await page.getByLabel('接入方式').locator('option').count(),2);
  await writeFile(join(temp,'package.json'),JSON.stringify({scripts:{start:'node app.js'}}));
  await writeFile(join(temp,'app.js'),'setInterval(()=>{},1000);');
  await page.getByLabel('项目文件夹').fill(temp);
  await page.getByLabel('端口',{exact:true}).fill(gameAddress.port);
  await page.getByRole('button',{name:'添加',exact:true}).click();
  await page.getByRole('heading',{name:'弹窗测试服务',exact:true}).waitFor();
  const addedCard=page.locator('.service-card').filter({has:page.getByRole('heading',{name:'弹窗测试服务',exact:true})});
  await addedCard.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('button',{name:'移除服务',exact:true}).click();
  await page.getByRole('button',{name:'确定移除',exact:true}).click();
  await page.getByRole('heading',{name:'弹窗测试服务',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.service-card').count(),1);

  await page.getByRole('button',{name:'查看日志'}).click();
  await page.getByRole('heading',{name:'测试节点 <script> · 实时日志'}).waitFor();
  await page.locator('.service-logs pre').filter({hasText:'此服务未接入本地日志源'}).waitFor();
  await page.getByRole('button',{name:'关闭日志'}).click();

  await page.screenshot({path:join(artifacts,'services-desktop.png'),fullPage:true});
  assert.equal(await page.locator('.server script').count(), 0, '服务器名称必须转义');
  await page.getByRole('navigation').getByRole('button', { name: '运行监控' }).click();
  await page.getByRole('heading', { name: '资源运行趋势' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.host-metrics article strong')?.textContent.includes('等待采样'));
  await page.waitForFunction(() => [...document.querySelectorAll('table tbody tr')].some(row => row.cells[1]?.textContent.includes('/s')), { timeout: 45000 });
  assert(await page.locator('.host-metrics .meter i').first().evaluate(el => el.style.width.length > 0));
  assert.equal(await page.locator('.metrics article').first().evaluate(el => getComputedStyle(el).borderRadius), '0px');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mint').trim()), '#4ed8af');
  assert.equal(await page.locator('.combined-chart > .panel:first-child .chart-line').count(), 4);
  assert(await page.locator('.combined-chart > .panel:first-child .chart-line').evaluateAll(lines => lines.every(line => getComputedStyle(line).fill === 'none')), '所有曲线应无填充，避免自动闭合形成多边形');
  await page.waitForFunction(() => ['purple', 'yellow'].every(color => document.querySelector('.combined-chart > .panel:first-child .chart-line.' + color)?.getAttribute('d').includes('L')), { timeout: 45000 });
  const plot = await page.locator('.combined-chart > .panel:first-child svg').boundingBox();
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
  await page.locator('.chart-tooltip').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.chart-tooltip>div').count(), 4);
  assert.equal(await page.locator('.chart-crosshair').count(), 1);
  await page.mouse.move(0, 0);
  await page.locator('.chart-tooltip').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.host-details').count(), 0);
  await page.getByRole('heading', { name: '磁盘空间' }).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: '系统信息' }).waitFor({ state: 'visible' });
  assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), '1440×900 应直接显示全部监控数据');
  assert(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily.includes('Noto Sans SC')));
  await page.screenshot({ path: join(artifacts, 'overview-desktop.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '运行监控' }).click();
  assert.equal(await page.locator('.server').count(), 0);
  await page.getByRole('heading', {name:'游戏运行数据'}).waitFor();
  assert.equal(await page.locator('.game-monitor tbody tr').count(), 1);

  let previousPlotHeight = 0;
  for (const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:2560,height:1440}]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const svg=document.querySelector('.combined-chart > .panel:first-child svg');
      return Math.abs(svg.viewBox.baseVal.height-svg.clientHeight)<2;
    });
    const layout=await page.evaluate(()=>{
      const panel=document.querySelector('.combined-chart > .panel:first-child').getBoundingClientRect();
      const plot=document.querySelector('.combined-chart > .panel:first-child svg').getBoundingClientRect();
      const footer=document.querySelector('main>footer').getBoundingClientRect();
      return {plotHeight:plot.height,unused:panel.bottom-plot.bottom,bottomGap:innerHeight-footer.bottom,scroll:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth};
    });
    assert(layout.scroll <= viewport.height, `${viewport.width}×${viewport.height} 监控页不应纵向溢出`);
    assert(layout.width <= viewport.width, '桌面不应横向溢出');
    assert(layout.unused <= 22, '图表下方不应留出大块空白');
    assert(layout.bottomGap >= 0 && layout.bottomGap <= 20, '内容应占满页面高度');
    assert(layout.plotHeight > previousPlotHeight, '更高屏幕应得到更高的图表');
    previousPlotHeight=layout.plotHeight;
    await page.screenshot({path:join(artifacts,`monitor-${viewport.width}x${viewport.height}.png`),fullPage:true});
  }

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '手机页面不应横向溢出');
  await page.screenshot({ path: join(artifacts, 'host-mobile.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '服务' }).click();
  await page.getByRole('button', { name: '重启', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click();
  await assert.rejects(access(marker), '取消操作不得执行命令');
  await page.getByRole('button', { name: '重启', exact: true }).click(); await page.getByRole('button', { name: '确认重启' }).click();
  await page.getByRole('status').filter({ hasText: '管理命令已成功执行' }).waitFor(); await access(marker);
  await page.getByRole('navigation').getByRole('button', { name: '设置' }).click();
  await page.getByLabel('插件目录').waitFor();
  for (const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:2560,height:1440},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'设置页不应横向溢出');
    await page.screenshot({path:join(artifacts,`settings-${viewport.width}x${viewport.height}.png`),fullPage:true});
  }

  await page.getByRole('button', {name:'保存设置'}).click();
  await page.getByRole('status').filter({hasText:'设置已保存'}).waitFor();
  await page.getByRole('navigation').getByRole('button', { name: '插件管理' }).click();
  await page.getByRole('heading', { name: '已安装插件' }).waitFor();
  await page.getByRole('button', { name: '重新扫描' }).click();
  await page.getByRole('button', { name: '打开' }).first().click();
  await page.locator('dialog.plugin-instance-dialog[open]').waitFor();
  await page.getByRole('button', { name: '启用', exact: true }).first().click();
  await page.getByRole('button', { name: '停用', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '停用', exact: true }).first().click();
  await page.getByRole('button', { name: '启用', exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(artifacts, 'plugins-mobile.png'), fullPage: true });
  await page.reload(); await page.getByRole('heading', { name: '运行监控' }).waitFor();
  await page.getByRole('button', { name: '退出', exact: true }).click(); await page.getByLabel('管理密码').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '手机登录页不应横向溢出');
  await page.screenshot({ path: join(artifacts, 'login-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('浏览器验证通过：登录、会话恢复、Vue 转义、性能采样、页面切换、趋势范围、导出、移动布局、操作确认及退出。');
  console.log(`截图：${artifacts}`);
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  game.closeAllConnections(); await new Promise(resolve => game.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
