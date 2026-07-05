// boot.js — runtime HTML partial loader (2.1). The ~21 modal dialogs live in
// html/modals/*.html so index.html stays small. No build step: we fetch the
// partials in the browser, inject them into #ex-partials (which sits inside the
// <body x-data="explorer"> scope), and only THEN load Alpine — so when Alpine
// starts it walks the completed DOM and runs each modal's x-init (setting the
// *ModalEl refs the component opens them by). Order is the whole trick: Alpine
// must not start until the partials are in the DOM.
(function () {
    'use strict';

    // Injected in this order; each file is a set of <div class="modal">… blocks.
    var PARTIALS = [
        'html/modals/windows.html',   // preview / editor window host
        'html/modals/files.html',     // permissions, compress, download-archive, drop-choice
        'html/modals/dialogs.html',   // confirm, prompt, directory picker
        'html/modals/mounts.html',    // mounts / fstab / SMB / NFS
        'html/modals/grub.html',      // GRUB editor
        'html/modals/actions.html',   // custom actions manager
        'html/modals/toolbar.html',   // settings, global actions, self-update, run command
        'html/modals/github.html',    // gh panel, commit browser, publish, …
    ];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    // alpine-sort (drag-reorder tabs) is a plugin and must be present before the
    // Alpine core boots; load it first, then core Alpine (which auto-starts).
    function startAlpine() {
        return loadScript('js/alpine-sort.min.js').then(function () {
            return loadScript('js/alpine.min.js');
        });
    }

    var host = document.getElementById('ex-partials');

    // Fetch all partials; inject whatever succeeds (a single failed file must not
    // block the rest, and Alpine must start regardless so the shell still works).
    Promise.allSettled(PARTIALS.map(function (p) {
        return fetch(p, { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error(p + ' → HTTP ' + r.status);
            return r.text();
        });
    })).then(function (results) {
        var html = results.map(function (res, i) {
            if (res.status === 'fulfilled') return res.value;
            console.error('[explorer] modal partial failed:', PARTIALS[i], res.reason);
            return '';
        }).join('\n');
        // NOTE: insertAdjacentHTML is safe here — `html` is our own trusted,
        // first-party template shipped in html/modals/*.html and fetched
        // same-origin under the plugin's strict CSP. It is NEVER user input.
        // (insertAdjacentText / DOMPurify would strip the Alpine x-* directives
        // these modals need, so they are not applicable.)
        if (host) host.insertAdjacentHTML('beforeend', html);
        else console.error('[explorer] #ex-partials host not found — modals will not load');
    }).catch(function (e) {
        console.error('[explorer] partial injection error:', e);
    }).then(startAlpine).catch(function (e) {
        console.error('[explorer] Alpine failed to start:', e);
    });
})();
