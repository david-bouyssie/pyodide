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
// JSPI overrides: runtime-swappable async syscall implementations
// ============================================================================
//
// Emscripten is built with -sJSPI_IMPORTS='[]' so it never Suspending-wraps
// any import. For the syscalls BridgedFS needs to make async, we install our
// own Suspending wrapper over a mutable internal record here, before
// instantiation:
//
//   jspiOverrides[name] = { fn: rawSyncFn, orig: rawSyncFn }
//   importSlot = new Suspending(async (...a) => await jspiOverrides[name].fn(...a))
//
// WASM captures importSlot at link time (immutable).
// fn is swappable at any time via the public API:
//   API.setJspiOverride("fd_read", myAsyncHandler);  // BridgedFS on
//   API.removeJspiOverride("fd_read");               // BridgedFS off (restores orig)
//
// jspiOverrides is intentionally internal — never exposed on API.
// Syscalls NOT listed here stay as plain sync imports — never suspend,
// safe to call from any context (loadPackage, print, etc.)

/** env namespace: Linux syscall wrappers */
const JSPI_ENV_SYSCALLS: readonly string[] = [
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

/** wasi_snapshot_preview1 namespace: WASI fd operations */
const JSPI_WASI_SYSCALLS: readonly string[] = [
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
 * Install Suspending-wrapped trampolines for every syscall in JSPI_ENV_SYSCALLS
 * and JSPI_WASI_SYSCALLS. Must be called after instrumentWasmImports() has run
 * (so the raw sync functions are in `imports`) but before
 * WebAssembly.instantiate() (so WASM captures our wrappers).
 *
 * Exposes API.setJspiOverride and API.removeJspiOverride for BridgedFS.
 */
function installJspiOverrides(
  imports: { [ns: string]: { [name: string]: any } },
  API: API,
): void {
  if (
    typeof WebAssembly === "undefined" ||
    !("Suspending" in WebAssembly)
  ) {
    return;
  }

  // Internal map — intentionally not exposed on API
  const jspiOverrides: Record<string, { fn: Function; orig: Function }> = {};

  function installOne(ns: { [name: string]: any }, name: string): void {
    const orig = ns[name];
    if (typeof orig !== "function") return;
    jspiOverrides[name] = { fn: orig, orig };
    ns[name] = new (WebAssembly as any).Suspending(
      async function (...args: any[]) {
        return await jspiOverrides[name].fn(...args);
      },
    );
  }

  const envNs = imports.env;
  if (envNs) {
    for (const name of JSPI_ENV_SYSCALLS) installOne(envNs, name);
  }

  const wasiNs = imports.wasi_snapshot_preview1;
  if (wasiNs) {
    for (const name of JSPI_WASI_SYSCALLS) installOne(wasiNs, name);
  }

  API.getJspiOverride = function (name: string): (...args: any[]) => any {
    if (!jspiOverrides[name]) {
      throw new Error(`getJspiOverride: unknown syscall "${name}"`);
    }
    return jspiOverrides[name].fn;
  };

  API.setJspiOverride = function (
    name: string,
    impl: (...args: any[]) => any,
  ): void {
    if (!jspiOverrides[name]) {
      throw new Error(`setJspiOverride: unknown syscall "${name}"`);
    }
    jspiOverrides[name].fn = impl;
  };

  API.removeJspiOverride = function (name: string): void {
    if (!jspiOverrides[name]) {
      throw new Error(`removeJspiOverride: unknown syscall "${name}"`);
    }
    jspiOverrides[name].fn = jspiOverrides[name].orig;
  };
}

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
    instantiateWasm: getInstantiateWasmFunc(config.indexURL, API),
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
  API: API,
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

      // Install Suspending-wrapped trampolines for BridgedFS-capable syscalls.
      // Emscripten built with -sJSPI_IMPORTS='[]' so imports arrive here
      // as plain sync functions — installJspiOverrides wraps the ones we need.
      installJspiOverrides(imports, API);

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
