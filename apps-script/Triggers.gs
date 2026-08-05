/**
 * FinPilot v0 — Triggers & Health.
 *
 * Installable triggers:
 *   - daily 02:00 — RecurringService.run() (materialize due recurring)
 *   - weekly Sunday — AnalyticsService.run() (regenerate analytics)
 *   - onOpen — installs the FinPilot menu
 */

var ApiHealth = {
  health: function () {
    var ss = openDb();
    var counts = {};
    Object.keys(TABLES).forEach(function (name) {
      counts[name] = tableCount(name);
    });
    return {
      data: {
        status: "ok",
        api_version: API_VERSION,
        schema_version: SettingsService.getRaw("schema_version"),
        time: new Date().toISOString(),
        timezone: SettingsService.getRaw("timezone"),
        base_currency: SettingsService.getRaw("base_currency"),
        tables: counts
      }
    };
  }
};

var TriggerService = {
  install: function () {
    var script = ScriptApp.getProjectTriggers();

    // recurring materializer (daily)
    if (!TriggerService.hasTrigger(script, "recurringNow")) {
      ScriptApp.newTrigger("recurringNow").timeBased().everyDays(1).atHour(2).create();
    }
    // analytics (weekly)
    if (!TriggerService.hasTrigger(script, "analyticsNow")) {
      ScriptApp.newTrigger("analyticsNow").timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
    }
  },

  hasTrigger: function (triggers, handler) {
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === handler) return true;
    }
    return false;
  }
};

/** Menu + trigger handlers. */
function analyticsNow() {
  try { AnalyticsService.run(); } catch (e) { Logger.log(e.stack); }
}
function recurringNow() {
  try { RecurringService.run(); } catch (e) { Logger.log(e.stack); }
}
function dashboardRefresh() {
  var ss = openDb();
  var sheet = ss.getSheetByName("dashboard");
  if (!sheet) sheet = DashboardService.buildLayout();
  DashboardService.installCharts();
  FormattingService.applyAll();
}
function triggerSetup() {
  TriggerService.install();
  SpreadsheetApp.getUi().alert("Triggers installed.");
}
