export interface ClientConfig {
  serverUrl: string;
  token?: string;
  storageKey?: string;
  fetchImpl?: typeof fetch;
}

export interface Entity {
  id: string;
  [key: string]: any;
}

export interface FilterOptions {
  sort?: string;
  limit?: number;
  skip?: number;
  fields?: string[] | string;
}

export interface EntityMethods {
  list(sort?: string, limit?: number, skip?: number, fields?: string[] | string): Promise<Entity[]>;
  filter(query: any, sort?: string, limit?: number, skip?: number, fields?: string[] | string): Promise<Entity[]>;
  get(id: string): Promise<Entity>;
  create(data: Record<string, any>): Promise<Entity>;
  update(id: string, data: Record<string, any>): Promise<Entity>;
  delete(id: string): Promise<void>;
  deleteMany(query: Record<string, any>): Promise<void>;
  bulkCreate(data: Record<string, any>[]): Promise<Entity[]>;
  importEntities(file: File): Promise<any>;
}

export interface EntitiesModule {
  [entityName: string]: EntityMethods;
}

export interface IntegrationEndpoint {
  (data: Record<string, any>): Promise<any>;
}

export interface IntegrationsPackage {
  [endpointName: string]: IntegrationEndpoint;
}

export interface IntegrationsModule {
  [packageName: string]: IntegrationsPackage;
}

export interface AuthModule {
  me(): Promise<Entity>;
  updateMe(data: Record<string, any>): Promise<Entity>;
  login(nextUrl?: string): void;
  logout(redirectUrl?: string): Promise<void>;
  setToken(token: string, saveToStorage?: boolean): void;
  isAuthenticated(): Promise<boolean>;
}

export interface Base44Client {
  entities: EntitiesModule;
  integrations: IntegrationsModule;
  auth: AuthModule;
  setToken(token: string): void;
  getConfig(): { serverUrl: string };
}

export class Base44Error extends Error {
  status?: number;
  code?: string;
  data?: any;
  originalError?: Error;
  constructor(message: string, status?: number, code?: string, data?: any, originalError?: Error) {
    super(message);
    this.name = 'Base44Error';
    this.status = status;
    this.code = code;
    this.data = data;
    this.originalError = originalError;
  }
}

type JSONValue = any;

function ensureBase(url: string) {
  return url.endsWith('/') ? url : url + '/';
}

function arrToCsv(v?: string[] | string) {
  return !v ? undefined : Array.isArray(v) ? v.join(',') : v;
}

function clean<T extends Record<string, any>>(o: T): T {
  const c = { ...o };
  Object.keys(c).forEach((k) => (c as any)[k] === undefined && delete (c as any)[k]);
  return c;
}

function createHttp(cfg: ClientConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const storageKey = cfg.storageKey ?? '__b44_token__';
  let token = cfg.token ?? (typeof window !== 'undefined' ? localStorage.getItem(storageKey) ?? undefined : undefined);

  const setToken = (t?: string, save?: boolean) => {
    token = t;
    if (typeof window !== 'undefined' && save) {
      if (t) localStorage.setItem(storageKey, t);
      else localStorage.removeItem(storageKey);
    }
  };

  const buildUrl = (path: string, q?: Record<string, any>) => {
    const u = new URL(path, ensureBase(cfg.serverUrl));
    if (q) Object.entries(q).forEach(([k, v]) => v != null && u.searchParams.append(k, String(v)));
    return u.toString();
  };

  const request = async (path: string, init?: RequestInit & { query?: Record<string, any> }) => {
    const url = buildUrl(path, init?.query);
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 204) return undefined;
    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text();
    let bodyParsed: any = bodyText;
    const looksJson = ct.includes('application/json') || ct.includes('application/problem+json');
    if (looksJson) {
      try {
        bodyParsed = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {}
    }
    if (!res.ok) {
      if (ct.includes('application/problem+json') && bodyParsed) {
        throw new Base44Error(bodyParsed.title || 'Request failed', bodyParsed.status ?? res.status, bodyParsed.type, bodyParsed);
      }
      throw new Base44Error(`HTTP ${res.status} ${res.statusText || ''}`.trim(), res.status, undefined, bodyParsed);
    }
    return looksJson ? bodyParsed.data  : bodyText;
  };

  return { request, setToken };
}

function createEntities(http: ReturnType<typeof createHttp>): EntitiesModule {
  return new Proxy({} as EntitiesModule, {
    get(_t, entityKey: string) {
      const e = String(entityKey);
      const m: EntityMethods = {
        list: (sort, limit, skip, fields) =>
          http.request(`entities/${encodeURIComponent(e)}`, {
            method: 'GET',
            query: clean({ sort, limit, skip, fields: arrToCsv(fields) }),
          }),
        filter: (query, sort, limit, skip, fields) =>
          http.request(`entities/${encodeURIComponent(e)}`, {
            method: 'GET',
            query: clean({
              q: JSON.stringify(query ?? {}),
              sort,
              limit,
              skip,
              fields: arrToCsv(fields),
            }),
          }),
        get: (id) => http.request(`entities/${encodeURIComponent(e)}/${encodeURIComponent(id)}`, { method: 'GET' }),
        create: (data) =>
          http.request(`entities/${encodeURIComponent(e)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }),
        update: (id, data) =>
          http.request(`entities/${encodeURIComponent(e)}/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }),
        delete: async (id) => {
          await http.request(`entities/${encodeURIComponent(e)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
        deleteMany: async (query) => {
          await http.request(`entities/${encodeURIComponent(e)}/deleteMany`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          });
        },
        bulkCreate: (data) =>
          http.request(`entities/${encodeURIComponent(e)}/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
          }),
        importEntities: (file: File) => {
          const form = new FormData();
          form.append('file', file);
          return http.request(`entities/${encodeURIComponent(e)}/import`, { method: 'POST', body: form });
        },
      };
      return m;
    },
  });
}

function createIntegrations(http: ReturnType<typeof createHttp>): IntegrationsModule {
  return new Proxy({} as IntegrationsModule, {
    get(_t, pkgKey: string) {
      const pkg = String(pkgKey);
      return new Proxy({} as IntegrationsPackage, {
        get(_t2, actionKey: string) {
          const action = String(actionKey);
          const fn: IntegrationEndpoint = (data) =>
            http.request(`integrations/${encodeURIComponent(pkg)}/${encodeURIComponent(action)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data ?? {}),
            });
          return fn;
        },
      });
    },
  });
}

function createAuth(http: ReturnType<typeof createHttp>, cfg: ClientConfig): AuthModule {
  return {
    me: () => http.request(`auth/me`, { method: 'GET' }),
    updateMe: (data) =>
      http.request(`auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    login: (nextUrl?: string) => {
      const url = new URL(`auth/login${nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : ''}`, ensureBase(cfg.serverUrl)).toString();
      if (typeof window !== 'undefined') window.location.href = url;
    },
    logout: async (redirectUrl?: string) => {
      await http.request(`auth/logout`, { method: 'POST' });
      http.setToken(undefined, true);
      if (redirectUrl && typeof window !== 'undefined') window.location.href = redirectUrl;
    },
    setToken: (t: string, save?: boolean) => http.setToken(t, save),
    isAuthenticated: async () => {
      try {
        await http.request(`auth/me`, { method: 'GET' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createClient(config: ClientConfig): Base44Client {
  if (!config?.serverUrl) throw new Error('serverUrl is required');
  const http = createHttp(config);
  const entities = createEntities(http);
  const integrations = createIntegrations(http);
  const auth = createAuth(http, config);
  return {
    entities,
    integrations,
    auth,
    setToken: (t: string) => http.setToken(t, true),
    getConfig: () => ({ serverUrl: config.serverUrl }),
  };
}