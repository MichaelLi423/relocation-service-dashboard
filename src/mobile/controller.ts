import type {
  MobileReadonlyOverview, MobileReadonlyOverviewData, MobileReadonlyProjectDetailData, MobileReadonlyProjectListData,
  MobileReadonlyPublishMetadata, MobileReadonlyQueryResponse, MobileReadonlyRecordKind,
  MobileReadonlyRecordsPage,
} from '../shared/mobile-readonly';

export const CHECK_INTERVAL_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 12_000;
export type CheckReason = 'open' | 'visible' | 'online' | 'periodic' | 'manual';
export interface MobileEnvironment {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  fetch: typeof fetch;
  isVisible(): boolean;
  isOnline(): boolean;
  subscribe(callback: (event: 'visible' | 'online' | 'offline') => void): () => void;
  /** Observes scheduling, including triggers coalesced behind an in-flight check. */
  onCheckTrigger?(reason: CheckReason, at: number): void;
}

export function browserEnvironment(): MobileEnvironment {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    fetch: (input, init) => fetch(input, init),
    isVisible: () => document.visibilityState === 'visible',
    isOnline: () => navigator.onLine,
    subscribe(callback) {
      const visible = () => { if (document.visibilityState === 'visible') callback('visible'); };
      const online = () => callback('online');
      const offline = () => callback('offline');
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      return () => {
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
      };
    },
  };
}

export interface ProjectFilters { query: string; status: string; region: string }
export type MobileNavigation =
  | { page: 'projects'; filters: ProjectFilters; cursor: string; previous: string[] }
  | { page: 'detail'; id: string; kind: MobileReadonlyRecordKind; cursor: string; previous: string[] };
export interface MobileView {
  metadata: MobileReadonlyPublishMetadata;
  overview: MobileReadonlyOverview | null;
  navigation: MobileNavigation;
  projects?: MobileReadonlyProjectListData;
  detail?: MobileReadonlyProjectDetailData;
  records?: MobileReadonlyRecordsPage;
}
export interface MobileState {
  view: MobileView | null;
  navigation: MobileNavigation;
  busy: boolean;
  lastCheckedAt: string | null;
  failedAt: string | null;
  error: string | null;
  notice: string | null;
}

class VersionChanged extends Error {}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validMetadata(value: unknown): value is MobileReadonlyPublishMetadata {
  if (!isRecord(value) || typeof value.published !== 'boolean'
    || typeof value.currentVersion !== 'number' || !Number.isSafeInteger(value.currentVersion) || value.currentVersion < 0) return false;
  if (!value.published) return value.currentVersion === 0 && value.publicationId === null
    && value.publishedAt === null && value.dataAsOf === null && value.fingerprint === null;
  const validTime = (time: unknown) => typeof time === 'string'
    && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time));
  return value.currentVersion > 0 && typeof value.publicationId === 'string' && value.publicationId.length > 0
    && validTime(value.publishedAt) && validTime(value.dataAsOf) && isRecord(value.fingerprint)
    && typeof value.fingerprint.contentGenerationId === 'string' && value.fingerprint.contentGenerationId.length > 0
    && typeof value.fingerprint.businessRevision === 'number' && Number.isSafeInteger(value.fingerprint.businessRevision)
    && value.fingerprint.businessRevision >= 0;
}
const emptyFilters = (): ProjectFilters => ({ query: '', status: '', region: '' });
const firstPage = (navigation: MobileNavigation): MobileNavigation => ({ ...navigation, cursor: '', previous: [] });

/** Memory-only view model. Each navigation is committed as one coherent version. */
export class MobileReadonlyController {
  private state: MobileState = {
    view: null, navigation: { page: 'projects', filters: emptyFilters(), cursor: '', previous: [] },
    busy: false, lastCheckedAt: null, failedAt: null, error: null, notice: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private checking = false;
  private queued = false;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private requests = new Set<AbortController>();
  private metadata: MobileReadonlyPublishMetadata | null = null;
  private overview: MobileReadonlyOverview | null = null;
  private listNavigation: MobileNavigation = this.state.navigation;

  constructor(private readonly env: MobileEnvironment = browserEnvironment()) {}
  getSnapshot = (): MobileState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<MobileState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  start = () => {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.env.subscribe((event) => {
      if (event === 'offline') this.fail('手机网络不可用；已加载内容仅保留在本页内存中。');
      else this.check(event);
    });
    this.schedule();
    this.check('open');
  };
  stop = () => {
    this.active = false;
    this.generation++;
    this.queued = false;
    this.unsubscribe?.();
    if (this.timer !== undefined) this.env.clearTimeout(this.timer);
    this.requests.forEach((request) => request.abort());
  };
  private schedule() {
    this.timer = this.env.setTimeout(() => {
      if (!this.active) return;
      // Scheduling is independent of network completion (no drift from slow requests).
      this.schedule();
      if (this.env.isVisible() && this.env.isOnline()) this.check('periodic');
    }, CHECK_INTERVAL_MS);
  }
  private fail(message = '无法连接或加载数据，请稍后重试。已显示的内容未更新。') {
    this.update({ failedAt: new Date(this.env.now()).toISOString(), error: message, busy: false });
  }
  private async request<T>(path: string): Promise<MobileReadonlyQueryResponse<T>> {
    if (!this.env.isOnline()) throw new Error('offline');
    const abort = new AbortController();
    this.requests.add(abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.env.fetch(path, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
          });
          if (response.status === 409) {
            const body: unknown = await response.json();
            if (isRecord(body) && isRecord(body.error) && body.error.code === 'STALE_CURSOR' && validMetadata(body.metadata)) {
              // The failed request is not a successful version check. Reload through overview.
              throw new VersionChanged();
            }
          }
          if (!response.ok) throw new Error('request failed');
          return await response.json() as MobileReadonlyQueryResponse<T>;
        })(),
        new Promise<never>((_, reject) => {
          timer = this.env.setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) this.env.clearTimeout(timer);
      this.requests.delete(abort);
    }
  }
  private acceptOverview(response: MobileReadonlyQueryResponse<MobileReadonlyOverviewData>) {
    const changed = this.metadata !== null && response.metadata.currentVersion !== this.metadata.currentVersion;
    this.metadata = response.metadata;
    this.overview = response.data.overview;
    this.update({ lastCheckedAt: new Date(this.env.now()).toISOString(), error: null, failedAt: null });
    if (changed) this.discard();
    return changed;
  }
  private discard() {
    this.generation++;
    this.update({ view: null, navigation: firstPage(this.state.navigation), busy: true,
      notice: '发布版本已改变，已丢弃旧结果，正在重新加载当前页面。' });
  }
  check = (reason: CheckReason = 'manual') => {
    if (!this.active) return;
    this.env.onCheckTrigger?.(reason, this.env.now());
    if (this.checking) { this.queued = true; return; }
    void this.runCheck();
  };
  private async runCheck() {
    this.checking = true;
    const generation = this.generation;
    try {
      const response = await this.request<MobileReadonlyOverviewData>('/api/overview');
      if (!this.active || generation !== this.generation) return;
      const changed = this.acceptOverview(response);
      if (changed || !this.state.view) await this.loadNavigation();
    } catch {
      if (this.active && generation === this.generation) this.fail();
    } finally {
      this.checking = false;
      if (this.active && this.queued) { this.queued = false; void this.runCheck(); }
    }
  }
  private async loadNavigation() {
    const generation = ++this.generation;
    this.update({ busy: true });
    // Publication racing is retried at most twice, then left for the next scheduled/user check.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0 || !this.metadata) {
          const response = await this.request<MobileReadonlyOverviewData>('/api/overview');
          if (!this.active || generation !== this.generation) return;
          this.metadata = response.metadata;
          this.overview = response.data.overview;
          this.update({ lastCheckedAt: new Date(this.env.now()).toISOString(), failedAt: null, error: null });
        }
        const metadata = this.metadata!;
        const navigation = this.state.navigation;
        const view: MobileView = { metadata, overview: this.overview, navigation };
        const sameVersion = <T,>(response: MobileReadonlyQueryResponse<T>): T => {
          if (response.metadata.currentVersion !== metadata.currentVersion) throw new VersionChanged();
          return response.data;
        };
        if (metadata.published) {
          if (navigation.page === 'projects') {
            const params = new URLSearchParams({ ...navigation.filters, cursor: navigation.cursor, limit: '20' });
            view.projects = sameVersion(await this.request<MobileReadonlyProjectListData>(`/api/projects?${params}`));
          } else {
            view.detail = sameVersion(await this.request<MobileReadonlyProjectDetailData>(`/api/project?${new URLSearchParams({ id: navigation.id })}`));
            if (!this.active || generation !== this.generation) return;
            if (view.detail.project) {
              const params = new URLSearchParams({ projectId: navigation.id, kind: navigation.kind, cursor: navigation.cursor, limit: '20' });
              view.records = sameVersion(await this.request<MobileReadonlyRecordsPage>(`/api/records?${params}`));
            }
          }
        }
        if (!this.active || generation !== this.generation) return;
        this.update({ view, busy: false, error: null, failedAt: null,
          notice: this.state.notice ? '发布版本已改变；旧结果已丢弃，当前页面已重新加载。' : null });
        return;
      } catch (error) {
        if (!this.active || generation !== this.generation) return;
        if (!(error instanceof VersionChanged)) { this.fail(); return; }
        this.update({ view: null, navigation: firstPage(this.state.navigation),
          notice: '发布版本已改变，已丢弃旧结果，正在重新加载当前页面。' });
      }
    }
    this.fail('发布版本持续变化，本次加载已暂停，请稍后重试。');
  }
  private navigate(navigation: MobileNavigation) {
    this.update({ navigation, error: null });
    void this.loadNavigation();
  }
  search = (filters: ProjectFilters) => {
    this.listNavigation = { page: 'projects', filters, cursor: '', previous: [] };
    this.navigate(this.listNavigation);
  };
  openProject = (id: string) => {
    if (this.state.navigation.page === 'projects') this.listNavigation = this.state.navigation;
    this.navigate({ page: 'detail', id, kind: 'batches', cursor: '', previous: [] });
  };
  backToProjects = () => this.navigate(firstPage(this.listNavigation));
  selectKind = (kind: MobileReadonlyRecordKind) => {
    if (this.state.navigation.page === 'detail' && this.state.navigation.kind !== kind) {
      this.navigate({ ...this.state.navigation, kind, cursor: '', previous: [] });
    }
  };
  nextPage = () => {
    const view = this.state.view;
    if (!view || this.state.busy) return;
    const next = view.navigation.page === 'projects' ? view.projects?.nextCursor : view.records?.nextCursor;
    if (next) this.navigate({ ...view.navigation, cursor: next, previous: [...view.navigation.previous, view.navigation.cursor] });
  };
  previousPage = () => {
    const navigation = this.state.view?.navigation;
    if (!navigation?.previous.length || this.state.busy) return;
    this.navigate({ ...navigation, cursor: navigation.previous[navigation.previous.length - 1], previous: navigation.previous.slice(0, -1) });
  };
  retry = () => { if (this.state.view) void this.loadNavigation(); this.check('manual'); };
}
