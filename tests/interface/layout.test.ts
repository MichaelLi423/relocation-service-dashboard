import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbench-interface 桌面布局静态约束', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
  const renderer = readFileSync(join(process.cwd(), 'src/renderer/components/workbench-v2.tsx'), 'utf8');

  it('正文、数据和控件使用统一的系统字体与 4px 间距基线', () => {
    expect(css).toContain('font-size:14px');
    expect(css).toContain('font-size:12px');
    expect(css).toContain('"Microsoft YaHei UI","PingFang SC"');
    expect(css).toContain('--radius-control:6px');
    expect(css).toContain('--radius-dialog:12px');
  });

  it('1024 附近不产生页面级横向溢出，宽表格在容器内滚动', () => {
    expect(css).toContain('body{margin:0;min-width:0');
    expect(css).toContain('overflow-x:clip');
    expect(css).toContain('.table-scroll{max-width:100%;overflow-x:auto}');
    expect(css).toContain('@media(max-width:1100px)');
  });

  it('纵向主流程依次显示提醒、单一项目工作区与项目队列', () => {
    const reminders = renderer.indexOf('id="reminders"');
    const queue = renderer.indexOf('id="project-queue"');
    const workspace = renderer.indexOf('className="project-workspace"');
    expect(reminders).toBeGreaterThan(0);
    expect(workspace).toBeGreaterThan(reminders);
    expect(queue).toBeGreaterThan(workspace);
    expect(renderer.match(/className="project-workspace"/g)).toHaveLength(1);
    expect(css).not.toContain('.workspace{display:grid;grid-template-columns:minmax(0,1fr) 330px');
    expect(css).not.toContain('.context{position:sticky');
  });

  it('只固定顶部导航，任务区保持紧凑并随页面滚动', () => {
    expect(css).toContain('.workbench-v2 .topbar{position:sticky;top:0;z-index:12');
    expect(css).toContain('.workbench-v2 .command{position:static;min-height:0');
    expect(css).not.toContain('sticky-command-height');
    expect(css).toContain('scroll-margin-top:calc(var(--topbar-height) + 16px)');
  });

  it('生命周期七个入口保持完整状态层级', () => {
    expect(css).toContain('grid-template-columns:repeat(7,minmax(136px,1fr))');
    expect(css).toContain('.status-pending_execution');
    expect(css).toContain('.status-pending_acceptance');
    expect(css).toContain('.workbench-v2 .stage[aria-pressed="true"]');
  });

  it('序列号地址更新在宽屏双栏、中等窗口上下排列且不改变二维码模块规则', () => {
    expect(css).toContain('.wide-drawer{width:min(1120px,calc(100vw - 24px))');
    expect(css).toContain('.wide-drawer .serial-address-module {');
    expect(css).toContain('grid-template-columns: minmax(360px, 380px) minmax(660px, 1fr)');
    expect(css).toMatch(/@media \(max-width: 1179px\).*\.wide-drawer \.serial-address-module.*grid-template-columns: minmax\(0, 1fr\)/s);
    expect(css).toContain('.wide-drawer{width:min(1000px,calc(100vw - 16px))}');
    expect(renderer).toContain('"qr-request-module" : "serial-address-module"');
    expect(css).toContain('.qr-request-module .data-table{min-width:680px}');
  });

  it('序列号记录使用专用列与移动卡片，不依赖逐行删除说明或左侧方位文案', () => {
    expect(css).toContain('.serial-address-table {');
    expect(css).toContain('min-width: 650px');
    expect(css).toContain('@media (max-width: 759px)');
    expect(css).toContain('.serial-address-table thead { display: none; }');
    expect(css).toContain('.serial-address-table tr {');
    expect(css).toContain('.serial-address-form .form-grid { grid-template-columns: minmax(0, 1fr); }');
    expect(renderer).toContain('className="serial-address-address" data-label="新址"');
    expect(renderer).toContain('className="serial-address-account" data-label="Account ID"');
    expect(renderer).toContain('记录有误时，删除后按最新资料重新登记。');
    expect(renderer).not.toContain('使用左侧表单新增记录。');
    expect(renderer).not.toContain('<small>地址事实有误时，删除后按最新资料重新登记。</small>');
  });

  it('数据管理入口与主导航共用高度、选中反馈和下拉层级', () => {
    expect(css).toContain('.data-menu{height:100%;display:flex;align-items:stretch}');
    expect(css).toContain('.data-menu summary:hover,.data-menu[open] summary');
    expect(css).toContain('min-width:176px');
  });

  it('1024 使用双层顶部导航且导航自身可横向滚动', () => {
    expect(css).toContain('.workbench-v2 .topbar nav{min-width:0;overflow-x:auto');
    expect(css).toMatch(/@media\(max-width:1100px\).*--topbar-height:106px.*grid-template-rows:59px 46px/s);
  });

  it('提醒泳道保留日期列头、列内加载和容器内横向滚动', () => {
    expect(renderer).toContain('data.dates.map((date) =>');
    expect(renderer).toContain('<time id={`lane-${date}`}');
    expect(renderer).toContain('className="reminder-lane-stack"');
    expect(renderer).toContain('selectedDates: data.dates');
    expect(renderer).toContain('加载本列更多');
    expect(css).toContain('.reminder-lane-scroll{max-width:100%;overflow-x:auto');
    expect(css).toContain('minmax(168px,1fr)');
    expect(css).toContain('minmax(176px,176px)');
  });

  it('项目切换时主状态控件与当前项目同步', () => {
    expect(renderer).toContain('value={draftStatus}');
    expect(renderer).toContain('[project?.id, project?.status]');
    expect(renderer).not.toContain('defaultValue={project.status}');
  });

  it('可编辑弹层拦截遮罩、Escape 与关闭按钮造成的未保存退出', () => {
    expect(renderer).toContain('protectDirty={layerRequiresDirtyProtection(layer)}');
    expect(renderer).toContain('role="alertdialog"');
    expect(renderer).toContain('放弃本次修改？');
    expect(renderer).toContain('if (discardOpenRef.current) closeDiscard()');
    expect(css).toContain('.discard-guard{position:fixed');
  });

  it('标签编辑弹窗固定头尾，仅中部选择区内部滚动并隔离滚动链', () => {
    expect(css).toContain('.project-tag-modal{width:min(720px,calc(100vw - 32px));max-height:min(760px,calc(100dvh - 48px));display:flex;flex-direction:column;overflow:hidden}');
    expect(css).toContain('.project-tag-modal .layer-head{flex:0 0 auto}');
    expect(css).toContain('.project-tag-edit-scroll{min-height:0;overflow-y:auto;overscroll-behavior:contain');
    expect(css).toContain('.project-tag-edit-footer{flex:0 0 auto;display:flex');
  });

  it('Layer 表单主操作通过 form 关联固定在标题栏，正文保持独立滚动', () => {
    expect(renderer).toContain('function LayerHeaderAction');
    expect(renderer).toContain('<div className="layer-header-actions" ref={setHeaderActions} />');
    expect(renderer).toContain('id="project-create-form"');
    expect(renderer).toContain('form="project-create-form"');
    expect(renderer).toContain('id="project-edit-form"');
    expect(renderer).toContain('form="project-edit-form"');
    expect(renderer).toContain('form="project-cancel-form" className="button danger"');
    expect(css).toContain('.layer-head{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;flex:0 0 auto');
    expect(css).toContain('.layer-body{min-height:0;overflow-y:auto;overscroll-behavior:contain');
    expect(css).toContain('@media(max-width:520px){.layer-head{grid-template-columns:minmax(0,1fr)');
  });

  it('新增和编辑项目不再收集或展示暂定仪器三字段，同时保留 UPS 与后续正式仪器数量入口', () => {
    expect(renderer).not.toContain('label="暂定仪器名称"');
    expect(renderer).not.toContain('label="暂定仪器数量"');
    expect(renderer).not.toContain('label="暂定型号"');
    expect(renderer).not.toContain('["暂定仪器名称"');
    expect(renderer).not.toContain('temporaryInstrumentName: value(');
    expect(renderer).not.toContain('addIfChanged("temporaryInstrumentCount"');
    expect(renderer).toContain('name="temporaryHasUps" label="UPS"');
    expect(renderer).toContain('name="instrumentCount" label="仪器数量"');
  });

  it('新增项目标题栏按钮随 intent 显示现有中文意图并保持原生表单提交', () => {
    expect(renderer).toContain('intentLabel[intent]');
    expect(renderer).toContain('<button form="project-create-form" className="button primary" disabled={busy}>');
    expect(renderer).toContain('pre_entry_execution: "未进单先执行"');
  });

  it('760px 下详情和队列标签入口保留稳定类、完整文字按钮及 40px 最小高度', () => {
    expect(renderer).toContain('detail-tag-entry');
    expect(renderer).toContain('queue-entry-actions');
    expect(css).toContain('.detail-tag-entry .project-tag-section-head .button{width:100%;min-height:40px}');
    expect(css).toContain('.queue-entry-actions .row-quick-action{min-height:40px}');
  });

  it('主要加载区提供可见反馈且保留 reduced motion 降级', () => {
    expect(renderer).toContain('正在读取工作台概况…');
    expect(css).toContain('.queue-table-wrap[aria-busy="true"]:before');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('历史、报表、危险操作与项目编辑表单保留响应式层级', () => {
    expect(css).toContain('.history-browser{display:grid');
    expect(css).toContain('.report-metric-grid{display:grid');
    expect(css).toContain('.danger-zone{');
    expect(css).toContain('.formal-intent-fields,.approval-fields');
    expect(css).toContain('.edit-form-section .form-grid{grid-template-columns:minmax(0,1fr)}');
  });

  it('项目队列明确固定每页20且不存在旧文案', () => {
    expect(renderer).toContain('固定每页20');
    expect(renderer).not.toContain('每页最多50项');
    expect(renderer).not.toContain('高密项目队列');
  });
});
