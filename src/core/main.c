#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <jslib.h>
#include <stdbool.h>

#define FAIL_IF_STATUS_EXCEPTION(status)                                       \
  if (PyStatus_Exception(status)) {                                            \
    goto finally;                                                              \
  }

// Initialize python. exit() and print message to stderr on failure.
static void
initialize_python(int argc, char** argv)
{
  bool success = false;
  PyStatus status;

  PyPreConfig preconfig;
  PyPreConfig_InitPythonConfig(&preconfig);

  status = Py_PreInitializeFromBytesArgs(&preconfig, argc, argv);
  FAIL_IF_STATUS_EXCEPTION(status);

  PyConfig config;
  PyConfig_InitPythonConfig(&config);

  status = PyConfig_SetBytesArgv(&config, argc, argv);
  FAIL_IF_STATUS_EXCEPTION(status);

  status = PyConfig_SetBytesString(&config, &config.home, "/");
  FAIL_IF_STATUS_EXCEPTION(status);

  config.write_bytecode = false;
  status = Py_InitializeFromConfig(&config);
  FAIL_IF_STATUS_EXCEPTION(status);

  success = true;
finally:
  PyConfig_Clear(&config);
  if (!success) {
    // This will exit().
    Py_ExitStatusException(status);
  }
}

PyObject*
PyInit__pyodide_core(void);

/*
 * Pre-import all Python modules that finalizeBootstrap would otherwise import
 * from JavaScript. This ensures all file I/O (.pyc reads, stdlib zip reads)
 * happens inside main(), which is wrapped with WebAssembly.promising() when
 * built with -sJSPI. Without this, the imports happen via rawRun() and
 * PyProxy.__pyproxy_apply calls from JS — non-promising WASM entry points
 * that crash if they hit Suspending-wrapped syscall imports.
 */
static int
preimport_bootstrap_modules(void)
{
  int rc = PyRun_SimpleString(
    // Phase 1: core modules (always available)
    "import _pyodide_core\n"
    "import importlib\n"
    "import importlib.abc\n"
    "import importlib.metadata\n"
    "import sys\n"
    "import os\n"
    "import builtins\n"
    "import __main__\n"
    "import pathlib\n"
    "\n"
    // Phase 2: pyodide modules (may not exist in bare builds)
    "try:\n"
    "    import _pyodide\n"
    "    import _pyodide._base\n"
    "    import _pyodide._importhook\n"
    "    import pyodide\n"
    "    import pyodide.code\n"
    "    import pyodide.ffi\n"
    "    import pyodide._package_loader\n"
    "except ImportError:\n"
    "    pass\n"
    "\n"
    // Phase 3: warm up non-import code paths
    "try:\n"
    "    from _pyodide._base import eval_code as _ec\n"
    "    _ec('{}')\n"
    "    del _ec\n"
    "    importlib.import_module('sys')\n"
    "    importlib.import_module('os')\n"
    "    importlib.import_module('builtins')\n"
    "    importlib.import_module('__main__')\n"
    "    _ = pyodide._package_loader.SITE_PACKAGES\n"
    "    _ = pyodide._package_loader.DSO_DIR\n"
    "    del _\n"
    "except Exception:\n"
    "    pass\n"
  );
  return rc;
}

/**
 * Bootstrap steps here:
 *  1. Import _pyodide package (we depend on this in _pyodide_core)
 *  2. Initialize the different ffi components and create the _pyodide_core
 *     module
 *  3. Create a PyProxy wrapper around _pyodide package so that JavaScript can
 *     call into _pyodide._base.eval_code and
 *     _pyodide._import_hook.register_js_finder (this happens in loadPyodide in
 *     pyodide.js)
 *
 * JSPI NOTE: When built with -sJSPI, Emscripten wraps main() with
 * WebAssembly.promising() and awaits it. All file I/O syscalls triggered
 * during main() can safely hit Suspending-wrapped imports.
 */
int
main(int argc, char** argv)
{
  // This exits and prints a message to stderr on failure,
  // no status code to check.
  PyImport_AppendInittab("_pyodide_core", PyInit__pyodide_core);
  initialize_python(argc, argv);

  // Pre-import all bootstrap modules while inside the promising main() frame.
  int rc = preimport_bootstrap_modules();
  if (rc != 0) {
    fprintf(stderr,
      "Pyodide: warning: preimport_bootstrap_modules failed (rc=%d). "
      "Bootstrap will retry imports from JS.\n", rc);
  }

  // Normally the runtime would exit when main() returns, don't let that
  // happen.
  emscripten_runtime_keepalive_push();
  return 0;
}

void
pymain_run_python(int* exitcode);

EMSCRIPTEN_KEEPALIVE int
run_main()
{
  int exitcode;
  // run_python may call exit() if `-h` or `-V` have been passed. If we stop it
  // from exiting, we'll segfault. So pop the keep alive, so that exit() will
  // call onExit and shut down the runtime. We notice this in pyodide.ts and
  // throw a ExitStatus error.
  emscripten_runtime_keepalive_pop();
  pymain_run_python(&exitcode);
  emscripten_runtime_keepalive_push();
  return exitcode;
}

void
set_suspender(JsVal suspender);

/**
 * call _pyproxy_apply but save the error flag into the argument so it can't be
 * observed by unrelated Python callframes. callPyObjectKwargsSuspending will
 * restore the error flag before calling pythonexc2js(). See
 * test_stack_switching.test_throw_from_switcher for a detailed explanation.
 */
EMSCRIPTEN_KEEPALIVE int
run_main_promising(JsVal suspender)
{
  set_suspender(suspender);
  return run_main();
}

EM_JS(void, log_ensure_gil, (int before, int after, int tss), {
  console.error(
    "ensure_gil: before=0x" + before.toString(16) +
    ", after=0x" + after.toString(16) +
    ", tss=0x" + tss.toString(16)
  );
});

/**
 * Re-acquire the GIL after main()'s promising frame has unwound.
 *
 * With JSPI, main() runs inside a WebAssembly.promising() wrapper. When it
 * returns and the Promise resolves, the wasm stack unwinds and CPython's
 * _PyRuntime.gilstate.tstate_current becomes NULL.
 *
 * PyGILState_Ensure() won't work here because it may create a new thread
 * state instead of restoring the original one, causing PyGILState_Check()
 * to fail later. Instead, we use PyEval_RestoreThread() with the TSS-stored
 * thread state (the original one from Py_Initialize) to acquire the GIL and
 * set tstate_current to the correct value.
 */
EMSCRIPTEN_KEEPALIVE void
ensure_gil(void)
{
  PyThreadState *tstate = PyGILState_GetThisThreadState();
  PyThreadState *before = PyThreadState_GetUnchecked();
  if (tstate && !before) {
    PyEval_RestoreThread(tstate);
  }
  PyThreadState *after = PyThreadState_GetUnchecked();
  log_ensure_gil((int)(uintptr_t)before,
                 (int)(uintptr_t)after,
                 (int)(uintptr_t)tstate);
}
