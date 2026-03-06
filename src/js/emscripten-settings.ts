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
