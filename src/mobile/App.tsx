import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MOBILE_READONLY_PROJECT_STATUSES, MOBILE_READONLY_RECORD_KINDS } from '../shared/mobile-readonly';
import type { MobileReadonlyProjectSummary, MobileReadonlyRecordKind, MobileReadonlyRecordRow } from '../shared/mobile-readonly';
import { MobileReadonlyController } from './controller';
import type { MobileState, ProjectFilters } from './controller';

export const STATUS_LABELS: Record<MobileReadonlyProjectSummary['status'], string> = {
  pending_entry: '待进单', pending_execution: '待执行', executing: '执行中', under_repair: '维修中',
  pending_acceptance: '待验收', pending_invoice: '待掉票', completed: '已完成', cancelled: '已取消',
};
export const RECORD_LABELS: Record<MobileReadonlyRecordKind, string> = {
  batches: '批次', instruments: '仪器', activities: '上门活动', orders: '开单', invoices: '掉票', damage_items: '损坏维修',
};
const ORDER_LABELS: Record<string, string> = { relocation: '搬迁', certification: '认证', parts_by_mail: '备件邮寄', pm: '预防性维护' };
const ISSUE_LABELS: Record<string, string> = { untreated: '未处理', processing: '处理中', repaired: '已修复', closed_unrepaired: '已关闭未修复' };
export function displayTime(value: string | null): string {
  if (!value) return '尚无';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}
function Fields({ values }: { values: [string, React.ReactNode][] }) {
  return <dl className="mr-fields">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null || value === '' ? '未填写' : value}</dd></div>)}</dl>;
}
function TimeValue({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{displayTime(value)}</time> : <>尚无</>;
}
function Freshness({ state, controller }: { state: MobileState; controller: MobileReadonlyController }) {
  const metadata = state.view?.metadata;
  return <section className="mr-freshness" aria-label="数据时间">
    <div className="mr-section-line"><span className="mr-tag">{metadata ? (metadata.published ? `已发布 · V${metadata.currentVersion}` : '尚未发布') : '等待加载'}</span><button onClick={() => controller.check()} className="mr-text-button">检查更新</button></div>
    <Fields values={[
      ['数据截至时间', <TimeValue value={metadata?.dataAsOf ?? null} />],
      ['发布完成时间', <TimeValue value={metadata?.publishedAt ?? null} />],
      ['最近成功检查', <TimeValue value={state.lastCheckedAt} />],
    ]} />
    <p className="mr-caption">北京时间 · 展示电脑最近发布的快照</p>
  </section>;
}
function Search({ controller, initial }: { controller: MobileReadonlyController; initial: ProjectFilters }) {
  const [filters, setFilters] = useState(initial);
  return <form className="mr-search" onSubmit={(event) => { event.preventDefault(); controller.search(filters); }}>
    <label htmlFor="mr-query">搜索项目</label>
    <input id="mr-query" type="search" placeholder="客户名称 / 临时编号 / ECC" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
    <div className="mr-filter-grid">
      <label>项目状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option>{MOBILE_READONLY_PROJECT_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
      <label>区域<input placeholder="全部区域" value={filters.region} onChange={(event) => setFilters({ ...filters, region: event.target.value })} /></label>
    </div>
    <div className="mr-search-actions"><button type="button" className="mr-text-button" onClick={() => { const empty = { query: '', status: '', region: '' }; setFilters(empty); controller.search(empty); }}>重置条件</button><button className="mr-primary" type="submit">查询项目</button></div>
  </form>;
}
function ProjectCard({ project, controller }: { project: MobileReadonlyProjectSummary; controller: MobileReadonlyController }) {
  return <li><button className="mr-project-card" onClick={() => controller.openProject(project.id)}>
    <span className="mr-section-line"><span className="mr-caption">{project.tempNo}</span><span className="mr-status">{STATUS_LABELS[project.status]}</span></span>
    <span className="mr-project-name">{project.customerName || '未填写客户名称'}<span aria-hidden="true"> ↗</span></span>
    <span className="mr-caption">ECC {project.ecc ?? '未填写'} · {project.region ?? '未填写区域'}{project.regionNeedsAdjustment ? ' · 区域待调整' : ''}</span>
    <span className="mr-card-footer"><span>计划上门 {project.planVisitAt ?? '未填写'}</span><span>查看详情 →</span></span>
  </button></li>;
}
function ProjectDetail({ project }: { project: MobileReadonlyProjectSummary }) {
  return <section className="mr-panel" aria-label="项目基础信息">
    <span className="mr-status">{STATUS_LABELS[project.status]}</span>
    <h2>{project.customerName || '未填写客户名称'}</h2>
    <Fields values={[
      ['临时编号', project.tempNo], ['ECC', project.ecc], ['项目标识', project.id],
      ['区域', project.region], ['区域待调整', project.regionNeedsAdjustment ? '是' : '否'],
      ['进单日期', project.entryAt], ['计划上门日期', project.planVisitAt],
      ['进单情况', project.formallyEntered ? '已进单' : '未进单'], ['未进单先执行', project.preEntryExecution ? '是' : '否'],
    ]} />
    <div className="mr-money-block"><Fields values={[
      ['合同金额', project.contractAmount], ['最终可确认金额', project.finalAmount], ['累计有效掉票', project.invoicedAmount],
    ]} /></div>
  </section>;
}
function recordFields(kind: MobileReadonlyRecordKind, row: MobileReadonlyRecordRow): [string, React.ReactNode][] {
  // Explicit field lists keep records within the published display contract.
  switch (kind) {
    case 'batches': { const r = row as Extract<MobileReadonlyRecordRow, { transportCompany: unknown }>; return [['记录标识', r.id], ['计划运输日期', r.planTransportDate], ['运输公司', r.transportCompany], ['开始运输日期', r.startedAt], ['物流费用登记日期', r.appliedAt]]; }
    case 'instruments': { const r = row as Extract<MobileReadonlyRecordRow, { model: unknown }>; return [['记录标识', r.id], ['仪器名称', r.name], ['型号', r.model], ['序列号', r.serialNo], ['UPS', r.ups ? '是' : '否']]; }
    case 'activities': { const r = row as Extract<MobileReadonlyRecordRow, { engineers: unknown }>; return [['记录标识', r.id], ['到访日期', r.visitAt], ['参与工程师', r.engineers]]; }
    case 'orders': { const r = row as Extract<MobileReadonlyRecordRow, { orderType: unknown }>; return [['记录标识', r.id], ['开单类型', ORDER_LABELS[r.orderType]], ['服务单号', r.serviceOrderNo], ['开单日期', r.orderedAt], ['参与工程师', r.engineer]]; }
    case 'invoices': { const r = row as Extract<MobileReadonlyRecordRow, { active: unknown }>; return [['记录标识', r.id], ['掉票金额', r.amount], ['掉票日期', r.invoicedAt], ['有效状态', r.active ? '有效' : '已撤销'], ['撤销日期', r.revokedAt]]; }
    case 'damage_items': { const r = row as Extract<MobileReadonlyRecordRow, { issueStatus: unknown }>; return [['记录标识', r.id], ['关联仪器', r.instrumentName], ['序列号', r.serialNo], ['事项状态', ISSUE_LABELS[r.issueStatus] ?? r.issueStatus], ['备件编号', r.partNumber], ['备件数量', r.partQuantity], ['备件金额', r.partAmount], ['币种', r.partCurrency], ['登记日期', r.registeredAt]]; }
  }
}
function Pagination({ state, controller }: { state: MobileState; controller: MobileReadonlyController }) {
  const view = state.view!;
  const next = view.navigation.page === 'projects' ? view.projects?.nextCursor : view.records?.nextCursor;
  return <nav className="mr-pagination" aria-label={view.navigation.page === 'projects' ? '项目翻页' : '记录翻页'}>
    <button disabled={state.busy || !view.navigation.previous.length} onClick={controller.previousPage}>← 上一页</button>
    <span>第 {view.navigation.previous.length + 1} 页</span>
    <button disabled={state.busy || !next} onClick={controller.nextPage}>下一页 →</button>
  </nav>;
}

export function MobileReadonlyApp({ controller: supplied }: { controller?: MobileReadonlyController }) {
  const [controller] = useState(() => supplied ?? new MobileReadonlyController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const view = state.view;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef<string>();
  useEffect(() => { controller.start(); return controller.stop; }, [controller]);
  useEffect(() => {
    if (view && previousPage.current && previousPage.current !== view.navigation.page) heading.current?.focus();
    if (view) previousPage.current = view.navigation.page;
  }, [view]);
  return <main className="mr-app">
    <header className="mr-header"><div><p className="mr-eyebrow">搬迁服务 / 只读查看</p><h1 ref={heading} tabIndex={-1}>{view?.navigation.page === 'detail' ? '项目详情' : '项目工作台'}</h1></div><span className="mr-readonly-mark" aria-hidden="true">只读</span></header>
    <Freshness state={state} controller={controller} />
    {state.notice && <p role="status" className="mr-notice">{state.notice}</p>}
    {state.error && <section role="alert" className="mr-error"><strong>{view ? '检查或加载失败，内容未更新' : '无法连接 / 无法加载'}</strong><p>{state.error}</p><p>失败时间：<TimeValue value={state.failedAt} /></p><button onClick={controller.retry}>重试加载</button></section>}
    {state.busy && <p role="status" className="mr-loading">正在加载；完成后显示本次查询结果…</p>}
    {!view && !state.error && !state.busy && <p role="status" className="mr-loading">正在连接只读服务…</p>}
    {view && !view.metadata.published && <section className="mr-empty"><h2>尚未发布数据</h2><p>电脑成功发布后，这里才会显示项目。</p></section>}
    {view?.metadata.published && <>
      {view.navigation.page === 'projects' ? <>
        {view.overview && <section className="mr-overview" aria-label="概览指标"><div className="mr-section-line"><h2>业务概览</h2><span className="mr-caption">快照时状态</span></div>
          <dl className="mr-metrics"><div><dt>项目总数</dt><dd>{view.overview.metrics.totalProjects}</dd></div><div><dt>活跃项目</dt><dd>{view.overview.metrics.activeProjects}</dd></div><div><dt>待验收</dt><dd>{view.overview.metrics.pendingAcceptance}</dd></div><div><dt>待掉票</dt><dd>{view.overview.metrics.pendingInvoice}</dd></div><div className="mr-amount"><dt>待掉票金额</dt><dd>{view.overview.metrics.pendingAmount}</dd></div></dl>
          <details className="mr-stages"><summary>阶段分布 <span>查看数量与平均停留天数</span></summary><p className="mr-caption">快照时状态 · 平均天数直接来自本次快照</p>{view.overview.stages.map((stage) => <div className="mr-stage" key={stage.status}><span>{STATUS_LABELS[stage.status]}</span><strong>{stage.count} 项</strong><span>平均 {stage.averageDays} 天</span></div>)}</details>
        </section>}
        <section aria-label="项目列表"><h2 className="mr-list-heading">搬迁项目</h2><Search controller={controller} initial={view.navigation.filters} />
          {view.projects?.items.length ? <ul className="mr-list">{view.projects.items.map((project) => <ProjectCard key={project.id} project={project} controller={controller} />)}</ul> : <div className="mr-empty"><h3>{view.overview?.metrics.totalProjects === 0 ? '已发布，暂无项目' : '没有匹配的项目'}</h3><p>{view.overview?.metrics.totalProjects === 0 ? '这是已发布的空快照。' : '请调整搜索词或筛选条件。'}</p></div>}
          <Pagination state={state} controller={controller} />
        </section>
      </> : <>
        <button className="mr-back" onClick={controller.backToProjects}>← 返回项目列表</button>
        {view.detail?.project ? <><ProjectDetail project={view.detail.project} /><section aria-label="关联记录"><h2 className="mr-list-heading">关联记录</h2>
          <div className="mr-tabs" role="group" aria-label="记录类型">{MOBILE_READONLY_RECORD_KINDS.map((kind) => <button key={kind} aria-pressed={view.navigation.page === 'detail' && view.navigation.kind === kind} onClick={() => controller.selectKind(kind)}>{RECORD_LABELS[kind]}</button>)}</div>
          <h3 className="mr-record-heading">{RECORD_LABELS[view.navigation.kind]}</h3>
          {view.records?.items.length ? <ul className="mr-list">{view.records.items.map((row) => <li key={row.id} className="mr-panel"><Fields values={recordFields(view.records!.kind, row)} /></li>)}</ul> : <div className="mr-empty">暂无{RECORD_LABELS[view.navigation.kind]}记录</div>}
          <Pagination state={state} controller={controller} />
        </section></> : <section className="mr-empty"><h2>当前快照中没有此项目</h2><p>请返回列表查看已发布的项目。</p></section>}
      </>}
    </>}
    <footer className="mr-footer">仅供查看，不提供业务修改。<br />电脑断网仅影响新发布；手机断网后重新打开无法加载。</footer>
  </main>;
}
