/** @private */

import { PyodideConfigWithDefaults } from "./pyodide";
import { initializeNativeFS } from "./nativefs";
import { loadBinaryFile, getBinaryResponse } from "./compat";
import { API, PreRunFunc, type PyodideModule, type FSType } from "./types";
import { getJsvErrorImport } from "generated/jsverror";
import { RUNTIME_ENV } from "./environments";

/**
 * @private
 * @hidden
 */
export interface EmscriptenSettings {
  readonly noImageDecoding?: boolean;
  readonly noAudioDecoding?: boolean;
  readonly noWasmDecoding?: boolean;
  readonly preRun: readonly PreRunFunc[];
  readonly print?: (a: string) => void;
  readonly printErr?: (a: string) => void;
  readonly onExit?: (code: number) => void;
  readonly thisProgram?: string;
  readonly arguments: readonly string[];
  readonly instantiateWasm?: (
    imports: { [key: string]: any },
    successCallback: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => void;
  readonly API: API;
  readonly locateFile: (file: string) => string;

  noInitialRun?: boolean;
  INITIAL_MEMORY?: number;
  exitCode?: number;
}

// ============================================================================
// JSPI: Suspending monkey-patch for async FS routing (D.6 technique)
// ============================================================================

const capturedRawSyscalls: Map<string, Function> = new Map();
let RealSuspending: any = null;
let suspendingPatched = false;

/**
 * Monkey-patch WebAssembly.Suspending to capture raw syscall functions.
 * Must be called BEFORE _createPyodideModule() which triggers Emscripten's
 * instrumentWasmImports().
 */
export function installSuspendingMonkeyPatch(): void {
  if (
    suspendingPatched ||
    typeof WebAssembly === "undefined" ||
    !("Suspending" in WebAssembly)
  ) {
    return;
  }

  RealSuspending = (WebAssembly as any).Suspending;

  (WebAssembly as any).Suspending = function PatchedSuspending(fn: Function) {
    const name = fn.name || "(anonymous)";
    capturedRawSyscalls.set(name, fn);
    return new RealSuspending(fn);
  };

  suspendingPatched = true;
}

const BRIDGED_ENV_SYSCALLS = [
  "__syscall_openat",
  "__syscall_stat64",
  "__syscall_fstat64",
  "__syscall_newfstatat",
  "__syscall_fcntl64",
  "__syscall_ioctl",
  "__syscall_faccessat",
  "__syscall_getdents64",
  "__syscall_readlinkat",
  "__syscall_mkdirat",
  "__syscall_unlinkat",
  "__syscall_renameat",
  "__syscall_rmdir",
  "__syscall_chmod",
  "__syscall_fchmod",
  "__syscall_truncate64",
  "__syscall_ftruncate64",
];

const BRIDGED_WASI_SYSCALLS = [
  "fd_read",
  "fd_write",
  "fd_pread",
  "fd_pwrite",
  "fd_seek",
  "fd_close",
  "fd_sync",
  "fd_fdstat_get",
];

/**
 * Replace Suspending-wrapped syscall imports with routing wrappers.
 * Called from getInstantiateWasmFunc, before WebAssembly.instantiate.
 */
function instrumentSyscallImports(imports: {
  [key: string]: { [key: string]: any };
}): void {
  if (!RealSuspending || capturedRawSyscalls.size === 0) {
    return;
  }

  function findRaw(name: string): Function | undefined {
    return (
      capturedRawSyscalls.get("_" + name) ||
      capturedRawSyscalls.get(name) ||
      capturedRawSyscalls.get("___" + name)
    );
  }

  for (const name of BRIDGED_ENV_SYSCALLS) {
    const rawFn = findRaw(name);
    if (!rawFn || !imports.env?.[name]) continue;

    const asyncWrapper = async function (...args: any[]) {
      const asyncFS = (globalThis as any).Module?.asyncFS;
      if (asyncFS && asyncFS[name]) {
        try {
          return await asyncFS[name](...args);
        } catch (e) {
          if ((e as any)?.fallthrough) {
            return rawFn(...args);
          }
          throw e;
        }
      }
      return rawFn(...args);
    };

    imports.env[name] = new RealSuspending(asyncWrapper);
  }

  const wasiNs = imports.wasi_snapshot_preview1;
  if (!wasiNs) return;

  for (const name of BRIDGED_WASI_SYSCALLS) {
    const rawFn = findRaw(name);
    if (!rawFn || !wasiNs[name]) continue;

    const asyncWrapper = async function (...args: any[]) {
      const asyncFS = (globalThis as any).Module?.asyncFS;
      if (asyncFS && asyncFS[name]) {
        try {
          return await asyncFS[name](...args);
        } catch (e) {
          if ((e as any)?.fallthrough) {
            return rawFn(...args);
          }
          throw e;
        }
      }
      return rawFn(...args);
    };

    wasiNs[name] = new RealSuspending(asyncWrapper);
  }
}

// ============================================================================
// Original emscripten-settings.ts code (unchanged except getInstantiateWasmFunc)
// ============================================================================

/**
 * Get the base settings to use to load Pyodide.
 *
 * @private
 */
export function createSettings(
  config: PyodideConfigWithDefaults,
): EmscriptenSettings {
  const API = { config, runtimeEnv: RUNTIME_ENV } as API;
  const settings: EmscriptenSettings = {
    noImageDecoding: true,
    noAudioDecoding: true,
    noWasmDecoding: false,
    preRun: getFileSystemInitializationFuncs(config),
    print: config.stdout,
    printErr: config.stderr,
    onExit(code) {
      settings.exitCode = code;
    },
    thisProgram: config._sysExecutable,
    arguments: config.args,
    API,
    locateFile: (path: string) => config.indexURL + path,
    instantiateWasm: getInstantiateWasmFunc(config.indexURL),
  };
  return settings;
}

function createHomeDirectory(path: string): PreRunFunc {
  return function (Module) {
    const fallbackPath = "/";
    try {
      Module.FS.mkdirTree(path);
    } catch (e) {
      console.error(`Error occurred while making a home directory '${path}':`);
      console.error(e);
      console.error(`Using '${fallbackPath}' for a home directory instead`);
      path = fallbackPath;
    }
    Module.FS.chdir(path);
  };
}

function setEnvironment(env: { [key: string]: string }): PreRunFunc {
  return function (Module) {
    Object.assign(Module.ENV, env);
  };
}

function callFsInitHook(
  fsInit: undefined | ((fs: FSType, info: { sitePackages: string }) => void),
): PreRunFunc[] {
  if (!fsInit) {
    return [];
  }
  return [
    async (Module) => {
      Module.addRunDependency("fsInitHook");
      try {
        await fsInit(Module.FS, { sitePackages: Module.API.sitePackages });
      } finally {
        Module.removeRunDependency("fsInitHook");
      }
    },
  ];
}

function computeVersionTuple(Module: PyodideModule): [number, number, number] {
  const versionInt = Module.HEAPU32[Module._Py_Version >>> 2];
  const major = (versionInt >>> 24) & 0xff;
  const minor = (versionInt >>> 16) & 0xff;
  const micro = (versionInt >>> 8) & 0xff;
  return [major, minor, micro];
}

function installStdlib(stdlibURL: string): PreRunFunc {
  const stdlibPromise: Promise<Uint8Array> = loadBinaryFile(stdlibURL);
  return async (Module: PyodideModule) => {
    Module.API.pyVersionTuple = computeVersionTuple(Module);
    const [pymajor, pyminor] = Module.API.pyVersionTuple;
    Module.FS.mkdirTree("/lib");
    Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
    Module.FS.mkdirTree(Module.API.sitePackages);
    Module.addRunDependency("install-stdlib");

    try {
      const stdlib = await stdlibPromise;
      Module.FS.writeFile(`/lib/python${pymajor}${pyminor}.zip`, stdlib);
    } catch (e) {
      console.error("Error occurred while installing the standard library:");
      console.error(e);
    } finally {
      Module.removeRunDependency("install-stdlib");
    }
  };
}

function getFileSystemInitializationFuncs(
  config: PyodideConfigWithDefaults,
): PreRunFunc[] {
  let stdLibURL;
  if (config.stdLibURL != undefined) {
    stdLibURL = config.stdLibURL;
  } else {
    stdLibURL = config.indexURL + "python_stdlib.zip";
  }

  return [
    installStdlib(stdLibURL),
    createHomeDirectory(config.env.HOME),
    setEnvironment(config.env),
    initializeNativeFS,
    ...callFsInitHook(config.fsInit),
  ];
}

function getInstantiateWasmFunc(
  indexURL: string,
): EmscriptenSettings["instantiateWasm"] {
  // @ts-ignore
  if (SOURCEMAP || typeof WasmOffsetConverter !== "undefined") {
    return;
  }
  const { binary, response } = getBinaryResponse(indexURL + "pyodide.asm.wasm");
  const jsvErrorImportPromise = getJsvErrorImport();
  return function (
    imports: { [key: string]: { [key: string]: any } },
    successCallback: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) {
    (async function () {
      const { Jsv_GetError_import, JsvError_Check } =
        await jsvErrorImportPromise;
      imports.env.Jsv_GetError_import = Jsv_GetError_import;
      imports.env.JsvError_Check = JsvError_Check;

      // JSPI: Replace Suspending-wrapped syscalls with routing wrappers
      instrumentSyscallImports(imports);

      try {
        let res: WebAssembly.WebAssemblyInstantiatedSource;
        if (response) {
          res = await WebAssembly.instantiateStreaming(response, imports);
        } else {
          res = await WebAssembly.instantiate(await binary, imports);
        }
        const { instance, module } = res;
        successCallback(instance, module);
      } catch (e) {
        console.warn("wasm instantiation failed!");
        console.warn(e);
      }
    })();

    return {};
  };
}
