export let suspenderGlobal = { value: null };
export let validSuspender = { value: false };

let promisingApplyHandler;
export function promisingApply(...args) {
  // validSuspender is a flag so that we can ask for permission before trying to
  // suspend.
  validSuspender.value = true;
  // Record the current stack position. Used in stack_state.mjs
  Module.stackStop = stackSave();
  return promisingApplyHandler(...args);
}

let promisingRunMainHandler;
export function promisingRunMain(...args) {
  // validSuspender is a flag so that we can ask for permission before trying to
  // suspend.
  validSuspender.value = true;
  // Record the current stack position. Used in stack_state.mjs
  Module.stackStop = stackSave();
  return promisingRunMainHandler(...args);
}

/**
 * This creates a wrapper around wasm_func that receives an extra suspender
 * argument and returns a promise. The suspender is stored into suspenderGlobal
 * so it can be used by syncify
 */
export function createPromising(wasm_func) {
  if (Module.newJspiSupported) {
    const promisingFunc = WebAssembly.promising(wasm_func);
    async function wrapper(...args) {
      const orig = validSuspender.value;
      validSuspender.value = true;
      try {
        return await promisingFunc(null, ...args);
      } finally {
        console.error("createPromising finally: about to restore_tss_tstate");
        Module._restore_tss_tstate();
        console.error("createPromising finally: restore_tss_tstate done");
        validSuspender.value = orig;
      }
    }
    return wrapper;
  }
  const { parameters } = wasmFunctionType(wasm_func);
  parameters.shift();
  return new WebAssembly.Function(
    { parameters, results: ["externref"] },
    wasm_func,
    { promising: "first" },
  );
}

/**
 * This sets up syncify to work.
 *
 * We need to make:
 *
 * - promisingApplyHandler which calls a Python function with stack switching
 *   enabled (used in callPyObjectKwargsSuspending in pyproxy.ts)
 */
export function initSuspenders() {
  // Emscripten's instrumentWasmExports() wraps every export with a JS arrow
  // function: ret[x] = (...args) => original(...args), storing the raw wasm
  // function as ret[x].orig. WebAssembly.promising() requires the raw wasm
  // export, not the JS wrapper.
  const applyFn = wasmExports._pyproxy_apply_promising;
  promisingApplyHandler = createPromising(applyFn.orig || applyFn);
  if (wasmExports.run_main_promising) {
    const runMainFn = wasmExports.run_main_promising;
    promisingRunMainHandler = createPromising(runMainFn.orig || runMainFn);
  }
}
