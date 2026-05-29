// Monaco worker bootstrap. Loaded as a Web Worker; its location is
// js/monaco/worker-wrapper.js, so relative paths resolve under js/monaco/.
self.MonacoEnvironment = { baseUrl: './' };
importScripts('vs/base/worker/workerMain.js');
