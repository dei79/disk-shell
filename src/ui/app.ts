import { terminalViewComponent } from "./components/terminal-view.js";

declare const SYNO: any;
declare const Vue: any;

(function registerDiskShellApplication() {
  "use strict";

  // DSM keeps third-party app stylesheets in the desktop document when an SPK
  // is upgraded without a full page reload. Remove older revisioned DiskShell
  // styles before loading the current one so obsolete tooltip rules cannot run
  // alongside the new UI.
  for (const stylesheet of document.querySelectorAll<HTMLLinkElement>(
    'link[data-diskshell-stylesheet], link[href*="webman/3rdparty/DiskShell/DiskShell-"]',
  )) stylesheet.remove();

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "webman/3rdparty/DiskShell/style.css";
  css.dataset.diskshellStylesheet = "true";
  document.head.appendChild(css);

  SYNO.namespace("SYNO.SDS.App.DiskShell");
  SYNO.SDS.App.DiskShell.Instance = Vue.extend({
    components: { "terminal-view": terminalViewComponent },
    template: [
      '<v-app-instance class-name="SYNO.SDS.App.DiskShell.Instance">',
      '  <v-app-window width="1040" height="680" ref="appWindow" :resizable="true" syno-id="SYNO.SDS.App.DiskShell.Window">',
      '    <terminal-view></terminal-view>',
      '  </v-app-window>',
      '</v-app-instance>',
    ].join(""),
  });
}());
