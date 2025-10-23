// ================== types ==================
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

export interface EntitiesModule {
  [entityName: string]: any;
}

export interface IntegrationsModule {
  [pkgName: string]: any;
}

export interface Base44Client {
  [namespace: string]: any; 
  entities: EntitiesModule;
  integrations: IntegrationsModule;
  auth: any;
  functions: any;
  agents: any;
  appLogs: any;
  asServiceRole: any;
  setToken(token: string): void;
  getConfig(): { serverUrl: string };
  cleanup(): void;
}

// ================== error ==================
export class Base44Error extends Error {
  status?: number;
  code?: string;
  data?: any;
  originalError?: Error;
  constructor(message: string, status?: number, code?: string, data?: any, originalError?: Error) {
    super(message);
    this.name = "Base44Error";
    this.status = status;
    this.code = code;
    this.data = data;
    this.originalError = originalError;
  }
}

// ================== helpers ==================
function ensureBase(url: string) {
  return url.endsWith("/") ? url : url + "/";
}

function arrToCsv(v?: string[] | string) {
  return !v ? undefined : Array.isArray(v) ? v.join(",") : v;
}

function clean<T extends Record<string, any>>(o: T): T {
  const c = { ...o };
  Object.keys(c).forEach((k) => (c as any)[k] === undefined && delete (c as any)[k]);
  return c;
}

// ================== http ==================
function createHttp(cfg: ClientConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const storageKey = cfg.storageKey ?? "__b44_token__";
  let token = cfg.token ?? (typeof window !== "undefined" ? localStorage.getItem(storageKey) ?? undefined : undefined);

  const setToken = (t?: string, save?: boolean) => {
    token = t;
    if (typeof window !== "undefined" && save) {
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
        Accept: "application/json",
        ...(init?.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (res.status === 204) return undefined;
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    const looksJson = ct.includes("application/json") || ct.includes("application/problem+json");

    let data: any = text;
    if (looksJson) {
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {}
    }

    if (!res.ok) {
      if (ct.includes("application/problem+json") && data) {
        throw new Base44Error(data.title || "Request failed", data.status ?? res.status, data.type, data);
      }
      throw new Base44Error(`HTTP ${res.status} ${res.statusText || ""}`.trim(), res.status, undefined, data);
    }

    return looksJson ? data.data ?? data : text;
  };

  const getConfig = () => ({ serverUrl: cfg.serverUrl });
  return { request, setToken, getConfig };
}

function createDynamicModule(basePath: string, http: ReturnType<typeof createHttp>) {
  return new Proxy(
    {},
    {
      get(_target, methodName: string) {
        const name = String(methodName);
        return async (...args: any[]) => {
          const [firstArg] = args;
          const isPost =
            typeof firstArg === "object" && !Array.isArray(firstArg) && Object.keys(firstArg || {}).length > 0;

          const opts: RequestInit & { query?: Record<string, any> } = isPost
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(firstArg ?? {}),
              }
            : { method: "GET", query: firstArg };

          return http.request(`${basePath}/${encodeURIComponent(name)}`, opts);
        };
      },
    }
  );
}

function createEntities(http: ReturnType<typeof createHttp>): EntitiesModule {
  return new Proxy(
    {},
    {
      get(_target, entityName: string) {
        const entity = String(entityName);
        return new Proxy(
          {},
          {
            get(_t2, methodName: string) {
              const method = String(methodName);
              return async (...args: any[]) => {
                switch (method) {
                  case "list":
                    return http.request(`entities/${entity}`, {
                      method: "GET",
                      query: clean({
                        sort: args[0]?.sort ?? args[0],
                        limit: args[0]?.limit ?? args[1],
                        skip: args[0]?.skip ?? args[2],
                        fields: arrToCsv(args[0]?.fields ?? args[3]),
                      }),
                    });
                  case "filter": {
                    const p = args[0] ?? {};
                    return http.request(`entities/${entity}`, {
                      method: "GET",
                      query: clean({
                        q: JSON.stringify(p.q ?? p ?? {}),
                        sort: p.sort,
                        limit: p.limit,
                        skip: p.skip,
                        fields: arrToCsv(p.fields),
                      }),
                    });
                  }
                  case "get":
                    return http.request(`entities/${entity}/${encodeURIComponent(args[0])}`, { method: "GET" });
                  case "create":
                    return http.request(`entities/${entity}`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(args[0]),
                    });
                  case "update":
                    return http.request(`entities/${entity}/${encodeURIComponent(args[0])}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(args[1]),
                    });
                  case "delete":
                    return http.request(`entities/${entity}/${encodeURIComponent(args[0])}`, { method: "DELETE" });
                  case "deleteMany":
                    return http.request(`entities/${entity}/deleteMany`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ query: args[0] }),
                    });
                  case "bulkCreate":
                    return http.request(`entities/${entity}/bulk`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ data: args[0] }),
                    });
                  case "importEntities":
                    const form = new FormData();
                    form.append("file", args[0]);
                    return http.request(`entities/${entity}/import`, { method: "POST", body: form });
                  default:
                    return http.request(`entities/${entity}`, { method: "GET", query: args[0] });
                }
              };
            },
          }
        );
      },
    }
  );
}

// ================== integrations (2-level) ==================
function createIntegrations(http: ReturnType<typeof createHttp>): IntegrationsModule {
  return new Proxy(
    {},
    {
      get(_target, pkgName: string) {
        const pkg = String(pkgName);
        return new Proxy(
          {},
          {
            get(_t2, actionName: string) {
              const action = String(actionName);
              return async (data?: any) =>
                http.request(`integrations/${pkg}/${action}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(data ?? {}),
                });
            },
          }
        );
      },
    }
  );
}

// ================== auth ==================
function createAuth(http: ReturnType<typeof createHttp>, cfg: ClientConfig) {
  return new Proxy(
    {},
    {
      get(_target, methodName: string) {
        const name = String(methodName);
        return async (...args: any[]) => {
          switch (name) {
            case "me":
              return http.request("auth/me", { method: "GET" });
            case "updateMe":
              return http.request("auth/me", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(args[0]),
              });
            case "login": {
              const nextUrl = args[0];
              const url = new URL(
                `auth/login${nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : ""}`,
                ensureBase(cfg.serverUrl)
              ).toString();
              if (typeof window !== "undefined") window.location.href = url;
              return;
            }
            case "logout": {
              const redirectUrl = args[0];
              await http.request("auth/logout", { method: "POST" });
              http.setToken(undefined, true);
              if (redirectUrl && typeof window !== "undefined") window.location.href = redirectUrl;
              return;
            }
            case "setToken":
              return http.setToken(args[0], args[1]);
            case "isAuthenticated":
              try {
                await http.request("auth/me", { method: "GET" });
                return true;
              } catch {
                return false;
              }
            default:
              return http.request(`auth/${name}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(args[0] ?? {}),
              });
          }
        };
      },
    }
  );
}

// ================== asServiceRole ==================
function createAsServiceRole(http: ReturnType<typeof createHttp>, token?: string) {
  const serviceHttp = { ...http };
  if (token) serviceHttp.setToken(token, false);
  return {
    entities: createEntities(serviceHttp),
    integrations: createIntegrations(serviceHttp),
    sso: createDynamicModule("sso", serviceHttp),
    functions: createDynamicModule("functions", serviceHttp),
    agents: createDynamicModule("agents", serviceHttp),
    appLogs: createDynamicModule("appLogs", serviceHttp),
    cleanup: () => {},
  };
}

// ================== cleanup ==================
function createCleanup() {
  return () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("__b44_token__");
    }
  };
}

// ================== createClient ==================
export function createClient(config: ClientConfig): Base44Client {
  if (!config?.serverUrl) throw new Error("serverUrl is required");

  const http = createHttp(config);
  const cleanup = createCleanup();

  const fixedModules: Record<string, any> = {
    entities: createEntities(http),
    integrations: createIntegrations(http),
    auth: createAuth(http, config),
    asServiceRole: createAsServiceRole(http, config.token),
    setToken: (t: string) => http.setToken(t, true),
    getConfig: () => ({ serverUrl: config.serverUrl }),
    cleanup,
  };

  const client = new Proxy(fixedModules, {
    get(target, prop: string, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);

      const dynamicModule = createDynamicModule(prop, http);
      Reflect.set(target, prop, dynamicModule);
      return dynamicModule;
    },
  });

  return client as Base44Client;
}
