// dsh-issue-fixer — browser half.
//
// Served by dsh-client-modules from `exports["./client"]`; a classic script in
// the plugin module wrapper, so there is no build step. It registers a
// "settings.section" slot that renders the first-install setup form and the
// live watcher status, talking to the host half over /issue-fixer/* routes.
window.__ModuleLoader__.load({
  id: "dsh-issue-fixer",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var NS = "issue-fixer";
    var STRINGS = {
      en: { nav: "Issue Fixer" },
      zh: { nav: "Issue 修复" },
    };
    var API = "/api/issue-fixer.";
    var inject = ["slots", "locale"];

    // ------------------------------------------------------------------ http

    function call(method, path, body) {
      return fetch(API + path, {
        method: method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (res) {
        return res.text().then(function (text) {
          var payload;
          try {
            payload = text === "" ? {} : JSON.parse(text);
          } catch (error) {
            payload = { error: "unexpected response from the issue-fixer host plugin" };
          }
          if (!res.ok) {
            var failure = new Error(payload && payload.error ? String(payload.error) : "request failed (" + res.status + ")");
            failure.payload = payload;
            throw failure;
          }
          return payload;
        });
      });
    }

    // ----------------------------------------------------------------- state

    function draftFrom(status) {
      var settings = (status && status.settings) || {};
      return {
        repo: settings.repo || "",
        cwd: settings.cwd || "",
        intervalMinutes: Math.max(1, Math.round((settings.intervalMs || 300000) / 60000)),
        labels: (settings.labels || []).join(", "),
        useGhCli: (settings.tokenSource || "gh-cli") !== "stored",
        token: "",
        autoPr: settings.autoPr === true,
        autoUpdate: settings.autoUpdate !== false,
      };
    }

    function payloadOf(draft) {
      return {
        repo: draft.repo,
        cwd: draft.cwd,
        intervalMinutes: Number(draft.intervalMinutes),
        labels: String(draft.labels || "")
          .split(",")
          .map(function (label) { return label.trim(); })
          .filter(Boolean),
        useGhCli: draft.useGhCli === true,
        githubToken: draft.useGhCli === true ? "" : draft.token,
        autoPr: draft.autoPr === true,
        autoUpdate: draft.autoUpdate !== false,
      };
    }

    function formatTime(value) {
      if (!value) return "never";
      var date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function phaseLabel(phase) {
      if (phase === "ready") return "Watching";
      if (phase === "blocked") return "Blocked";
      if (phase === "setup-required") return "Setup required";
      if (phase === "unavailable") return "Unavailable";
      return "Starting";
    }

    // ---------------------------------------------------------------- styles

    var S = {
      page: {
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 760,
        paddingBottom: 24,
        color: "inherit",
        fontSize: 13,
        lineHeight: 1.55,
      },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      sub: { margin: "4px 0 0", opacity: 0.72 },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: 10,
        border: "1px solid rgba(128,128,128,0.28)",
        background: "rgba(128,128,128,0.06)",
      },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600, opacity: 0.9 },
      banner: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 14px",
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: "solid",
      },
      field: { display: "flex", flexDirection: "column", gap: 4 },
      label: { fontWeight: 600, opacity: 0.9 },
      input: {
        padding: "6px 9px",
        borderRadius: 6,
        border: "1px solid rgba(128,128,128,0.4)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 13,
        width: "100%",
        boxSizing: "border-box",
      },
      hint: { margin: 0, opacity: 0.65, fontSize: 12 },
      actions: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
      button: {
        padding: "6px 14px",
        borderRadius: 7,
        border: "1px solid rgba(128,128,128,0.4)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 13,
        cursor: "pointer",
      },
      primary: {
        padding: "6px 16px",
        borderRadius: 7,
        border: "1px solid transparent",
        background: "#2f6fed",
        color: "#ffffff",
        font: "inherit",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      },
      row: { display: "flex", gap: 8, alignItems: "baseline" },
      rowKey: { minWidth: 132, opacity: 0.65, flex: "0 0 auto" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
      check: { display: "flex", gap: 8, alignItems: "baseline" },
      mark: { width: 14, flex: "0 0 auto", textAlign: "center" },
    };

    var TONES = {
      good: { color: "#2f9e44", borderColor: "rgba(47,158,68,0.45)", background: "rgba(47,158,68,0.1)" },
      warn: { color: "#c98a00", borderColor: "rgba(201,138,0,0.45)", background: "rgba(201,138,0,0.1)" },
      bad: { color: "#d64545", borderColor: "rgba(214,69,69,0.45)", background: "rgba(214,69,69,0.1)" },
      info: { color: "inherit", borderColor: "rgba(128,128,128,0.35)", background: "rgba(128,128,128,0.08)" },
    };

    function banner(tone, title, detail) {
      var style = Object.assign({}, S.banner, TONES[tone] || TONES.info);
      return h(
        "div",
        { style: style, role: "status" },
        h("div", { style: { fontWeight: 600 } }, title),
        detail === undefined || detail === null || detail === "" ? null : h("div", { style: { opacity: 0.85 } }, detail),
      );
    }

    function field(label, hint, control) {
      return h(
        "label",
        { style: S.field },
        h("span", { style: S.label }, label),
        control,
        hint ? h("span", { style: S.hint }, hint) : null,
      );
    }

    function checkRow(ok, text, detail) {
      return h(
        "div",
        { style: S.check },
        h("span", { style: Object.assign({}, S.mark, { color: ok ? "#2f9e44" : "#d64545" }) }, ok ? "✓" : "✕"),
        h("span", {}, text, detail ? h("span", { style: Object.assign({}, S.hint, { marginLeft: 6 }) }, detail) : null),
      );
    }

    function row(key, value) {
      return h(
        "div",
        { style: S.row },
        h("span", { style: S.rowKey }, key),
        typeof value === "string" || typeof value === "number" ? h("span", { style: S.mono }, String(value)) : value,
      );
    }

    // ------------------------------------------------------------- the panel

    function panel(t) {
      return function IssueFixerSection() {
        var statusState = react.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];

        var draftState = react.useState(null);
        var draft = draftState[0];
        var setDraft = draftState[1];

        var touchedBox = react.useState({ touched: false })[0];

        var busyState = react.useState("");
        var busy = busyState[0];
        var setBusy = busyState[1];

        var noteState = react.useState(null);
        var note = noteState[0];
        var setNote = noteState[1];

        var reportState = react.useState(null);
        var report = reportState[0];
        var setReport = reportState[1];

        function adopt(next, replaceDraft) {
          setStatus(next);
          setDraft(function (previous) {
            if (replaceDraft || previous === null) return draftFrom(next);
            return previous;
          });
        }

        function refresh(replaceDraft) {
          return call("GET", "status")
            .then(function (next) {
              adopt(next, replaceDraft === true || !touchedBox.touched);
              return next;
            })
            .catch(function (error) {
              setStatus({ phase: "unavailable", error: String(error.message || error) });
              throw error;
            });
        }

        react.useEffect(function () {
          var alive = true;
          call("GET", "status")
            .then(function (next) {
              if (alive) adopt(next, true);
            })
            .catch(function (error) {
              if (alive) setStatus({ phase: "unavailable", error: String(error.message || error) });
            });
          return function () {
            alive = false;
          };
        }, []);

        var phase = status ? status.phase : "loading";
        react.useEffect(
          function () {
            if (phase !== "ready" && phase !== "blocked") return undefined;
            var timer = setInterval(function () {
              call("GET", "status").then(adopt, function () {});
            }, 15000);
            return function () {
              clearInterval(timer);
            };
          },
          [phase],
        );

        function edit(patch) {
          touchedBox.touched = true;
          setDraft(function (previous) {
            return Object.assign({}, previous || {}, patch);
          });
        }

        function runCheck() {
          setBusy("check");
          setNote(null);
          call("POST", "check", payloadOf(draft))
            .then(function (result) {
              setReport(result);
              setStatus(function (previous) {
                return Object.assign({}, previous || {}, { phase: result.phase, problems: result.problems, identity: result.identity, access: result.access, checkout: result.checkout });
              });
              setNote(result.phase === "ready"
                ? { kind: "good", text: "All checks passed — save to start watching." }
                : { kind: "bad", text: "Not ready yet. Fix the failing item below." });
            })
            .catch(function (error) {
              setReport(error.payload || null);
              setNote({ kind: "bad", text: String(error.message || error) });
            })
            .then(function () {
              setBusy("");
            });
        }

        function runSave() {
          setBusy("save");
          setNote(null);
          call("POST", "save", payloadOf(draft))
            .then(function (result) {
              touchedBox.touched = false;
              setReport(result.status || result);
              setDraft(Object.assign(draftFrom(result.status || result), { token: "" }));
              setStatus(result.status || null);
              setNote({ kind: "good", text: "Saved — the watcher is running." });
            })
            .catch(function (error) {
              setReport(error.payload || null);
              setNote({ kind: "bad", text: String(error.message || error) });
            })
            .then(function () {
              setBusy("");
            });
        }

        function runReset() {
          setBusy("reset");
          setNote(null);
          call("POST", "reset", {})
            .then(function (result) {
              touchedBox.touched = false;
              setReport(null);
              setDraft(draftFrom(result.status));
              setStatus(result.status);
              setNote({ kind: "info", text: "Settings cleared. Fill the form again to restart." });
            })
            .catch(function (error) {
              setNote({ kind: "bad", text: String(error.message || error) });
            })
            .then(function () {
              setBusy("");
            });
        }

        var disabled = busy !== "";
        var live = status && status.access && status.access.ok ? status.access : null;

        // -- status banner
        var statusBanner;
        if (!status) {
          statusBanner = banner("info", "Loading issue-fixer status…");
        } else if (status.phase === "unavailable") {
          statusBanner = banner("bad", "Issue Fixer host plugin is not responding", status.error);
        } else if (status.phase === "ready") {
          statusBanner = banner(
            "good",
            "Watching " + status.settings.repo,
            (status.identity ? "Signed in as " + status.identity.login : "") +
              (status.access ? " · " + (status.access.private ? "private" : "public") + " repository" : "") +
              (status.verifiedAt ? " · verified " + formatTime(status.verifiedAt) : ""),
          );
        } else {
          var problemText = (status.problems || []).map(function (problem) { return problem.message; });
          if (problemText.length === 0) {
            problemText = [status.identity && status.identity.ok === false ? status.identity.error : null,
              status.access && status.access.ok === false ? status.access.error : null,
              status.error].filter(Boolean);
          }
          statusBanner = banner(
            status.phase === "blocked" ? "bad" : "warn",
            status.phase === "blocked" ? "Blocked" : "Setup required before the watcher can start",
            problemText.length > 0 ? problemText.join(" ") : "Fill in the fields below.",
          );
        }

        // -- verdict of the last check / save
        var verdict = null;
        if (report && (report.identity || report.access || report.checkout)) {
          var checks = [];
          if (report.identity) checks.push(checkRow(report.identity.ok, report.identity.ok ? "Signed in as " + report.identity.login : "GitHub identity", report.identity.ok ? "via " + report.identity.source : report.identity.error));
          if (report.access) checks.push(checkRow(report.access.ok, report.access.ok ? "Push access to " + report.access.repo : "Repository access", report.access.ok ? "admin/maintain/push" : report.access.error));
          if (report.checkout) {
            (report.checkout.checks || []).forEach(function (item) {
              checks.push(checkRow(item.ok, item.label || item.id, item.detail || ""));
            });
          }
          verdict = h("div", { style: S.card }, h("h3", { style: S.cardTitle }, "Check results"), checks);
        }

        var activity = null;
        if (status && status.activity) {
          var act = status.activity;
          var rows = [
            row("Last poll", formatTime(act.lastPollAt)),
            row("Baseline", act.baseline && act.baseline.number ? act.baseline.repo + "#" + act.baseline.number : "none yet"),
            row("Fixed / failed", (act.counts ? act.counts.done : 0) + " / " + (act.counts ? act.counts.failed : 0)),
          ];
          if (act.lastError) rows.push(row("Last error", h("span", { style: S.mono }, act.lastError)));
          if (status.update) {
            var up = status.update;
            rows.push(row("Self-update", up.applied
              ? "updated " + up.current + " → " + up.latest + " (" + (up.mode || "?") + ") — restart DSH Desktop to activate"
              : (up.error ? h("span", { style: S.mono }, up.error) : "current " + (up.current || "?") + (up.latest ? " · latest " + up.latest : ""))));
          }
          if (act.recent && act.recent.length > 0) {
            rows.push(row("Recent", h("div", { style: S.mono }, act.recent.map(function (item) {
              return "#" + item.number + " " + (item.title ? item.title + " · " : "") + (item.status || "?")
                + (item.branch ? " · " + item.branch : "")
                + (item.prUrl ? " · PR opened" : "")
                + (item.prError ? " · PR failed" : "");
            }).join("\n"))));
          }
          activity = h("div", { style: S.card }, h("h3", { style: S.cardTitle }, "Activity"), rows);
        }

        var form = draft
          ? h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 16 } },
            h(
              "div",
              { style: S.card },
              h("h3", { style: S.cardTitle }, "1. Repository and checkout"),
              field("GitHub repository", "owner/name — the account below must own it or have push access",
                h("input", { style: S.input, value: draft.repo, placeholder: "owner/repository", disabled: disabled, onChange: function (event) { edit({ repo: event.target.value }); } })),
              field("Working directory", "absolute path of the local git checkout; fixes are committed here",
                h("input", { style: S.input, value: draft.cwd, placeholder: "C:\\path\\to\\checkout", disabled: disabled, onChange: function (event) { edit({ cwd: event.target.value }); } })),
              field("Poll interval (minutes)", "at least 1; the watcher reads open issues on every tick",
                h("input", { style: S.input, type: "number", min: 1, value: draft.intervalMinutes, disabled: disabled, onChange: function (event) { edit({ intervalMinutes: event.target.value }); } })),
              field("Only these labels (comma separated)", "optional — an issue must carry every listed label",
                h("input", { style: S.input, value: draft.labels, placeholder: "bug, needs-fix", disabled: disabled, onChange: function (event) { edit({ labels: event.target.value }); } })),
            ),
            h(
              "div",
              { style: S.card },
              h("h3", { style: S.cardTitle }, "2. GitHub account"),
              h(
                "label",
                { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("input", { type: "radio", checked: draft.useGhCli, disabled: disabled, onChange: function () { edit({ useGhCli: true }); } }),
                h("span", {}, "Use the GitHub CLI login on this machine (", h("span", { style: S.mono }, "gh auth"), ")"),
              ),
              h(
                "label",
                { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("input", { type: "radio", checked: !draft.useGhCli, disabled: disabled, onChange: function () { edit({ useGhCli: false }); } }),
                h("span", {}, "Personal access token"),
              ),
              draft.useGhCli
                ? null
                : field("Token", "classic or fine-grained token with repository read/write permission",
                  h("input", { style: S.input, type: "password", autoComplete: "off", value: draft.token, placeholder: "ghp_…", disabled: disabled, onChange: function (event) { edit({ token: event.target.value }); } })),
              h(
                "label",
                { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("input", { type: "checkbox", checked: draft.autoPr === true, disabled: disabled, onChange: function (event) { edit({ autoPr: event.target.checked }); } }),
                h("span", {}, "After each fix: push the branch and open a pull request automatically"),
              ),
              h(
                "label",
                { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("input", { type: "checkbox", checked: draft.autoUpdate !== false, disabled: disabled, onChange: function (event) { edit({ autoUpdate: event.target.checked }); } }),
                h("span", {}, "Keep the plugin itself up to date (checks GitHub releases daily)"),
              ),
              h("p", { style: S.hint }, "The plugin only runs when this account owns the repository or has push, maintain or admin access. Read-only clones are rejected."),
            ),
            h(
              "div",
              { style: S.actions },
              h("button", { style: S.button, disabled: disabled, onClick: runCheck }, busy === "check" ? "Checking…" : "Check access"),
              h("button", { style: S.primary, disabled: disabled, onClick: runSave }, busy === "save" ? "Saving…" : "Save and start watching"),
              h("button", { style: S.button, disabled: disabled, onClick: function () { refresh(true).catch(function (error) { setNote({ kind: "bad", text: String(error.message || error) }); }); } }, "Refresh"),
              h("button", { style: S.button, disabled: disabled, onClick: runReset }, "Clear settings"),
            ),
          )
          : null;

        return h(
          "section",
          { style: S.page, "aria-label": t("nav") },
          h("div", {}, h("h2", { style: S.title }, t("nav")), h("p", { style: S.sub }, "Watches one GitHub repository and fixes its open issues with an agent session. Nothing runs until this form is complete.")),
          statusBanner,
          note ? banner(note.kind, note.text) : null,
          form,
          verdict,
          activity,
          status && status.stateFile ? h("p", { style: S.hint }, "State file: " + status.stateFile) : null,
        );
      };
    }

    // ------------------------------------------------------------- lifecycle

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, STRINGS);
      }, "issue-fixer: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: NS, order: 120, label: function () { return t("nav"); }, locale: NS },
          panel(t),
        );
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  },
});
;
//# sourceMappingURL=??dsh-issue-fixer/client.js.map&rev=6928bbae34af
