/**
 * FinPilot v0 — Schema Service (bootstrap).
 *
 * Builds the entire workbook from an empty file: creates every table sheet,
 * seeds lookups, settings, validation rules, seeds a starter master data set,
 * applies formatting/validation/charts and installs triggers.
 *
 * Idempotent: running it again only fills gaps; never destroys data.
 * Call from a menu: FinPilot → Initialize Workbook.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  if (!ui) return;
  ui.createMenu("FinPilot")
    .addItem("Initialize Workbook", "schemaInitialize")
    .addItem("Run Analytics", "analyticsNow")
    .addItem("Materialize Recurring", "recurringNow")
    .addItem("Open Dashboard", "gotoDashboard")
    .addSeparator()
    .addItem("Setup Triggers", "triggerSetup")
    .addItem("Install Charts", "dashboardRefresh")
    .addToUi();
}

function schemaInitialize() {
  withLock(function () {
    SchemaService.initialize();
    SpreadsheetApp.getUi().alert("FinPilot initialized. Open the Dashboard tab.");
  });
}

var SchemaService = {
  initialize: function () {
    var ss = openDb();

    // persist the database id for the portability of openDb()
    try {
      PropertiesService.getScriptProperties().setProperty("database_id", ss.getId());
    } catch (e) { Logger.log("persist database_id: " + e.message); }

    // 1. create every table sheet
    Object.keys(TABLES).forEach(function (name) {
      ensureSheet(ss, TABLES[name]);
    });

    // 2. seed configuration + master data
    SettingsService.ensureDefaults();
    LookupService.ensureDefaults();
    ValidationService.ensureDefaults();
    SchemaService.seedStarterData();
    SettingsService.set("schema_version", SCHEMA_VERSION, "STRING");

    // 3. reporting layer
    DashboardService.buildLayout();
    DashboardService.installCharts();
    FormattingService.applyAll();

    // 4. analytics + score + roadmap for the current period
    AnalyticsService.run();

    // 5. triggers
    TriggerService.install();

    return true;
  },

  /** Minimal starter data so the dashboard isn't empty on first run. */
  seedStarterData: function () {
    if (tableCount("accounts") > 0) return;

    var now = isoNow();
    var accounts = [
      { name: "Cash Wallet", type: "WALLET", opening: 200, color: "#FBBC04", icon: "wallet" },
      { name: "Main Bank", type: "BANK", opening: 0, color: "#4285F4", icon: "bank" },
      { name: "Savings", type: "SAVINGS", opening: 0, color: "#34A853", icon: "piggy" }
    ];
    var accIds = accounts.map(function (a) {
      var rec = {
        account_id: IdGenerator.account(), name: a.name, type: a.type,
        currency: SettingsService.getRaw("base_currency"),
        opening_balance: a.opening, current_balance: "",
        color: a.color, icon: a.icon, status: "ACTIVE",
        is_credit: "FALSE", note: "", created_date: todayStamp(), created_at: now
      };
      appendRow("accounts", rec);
      return rec.account_id;
    });

    var cats = [
      { name: "Food & Dining", icon: "food", color: "#EA4335" },
      { name: "Transport", icon: "car", color: "#4285F4" },
      { name: "Utilities", icon: "home", color: "#FBBC04" },
      { name: "Entertainment", icon: "star", color: "#9C27B0" },
      { name: "Health", icon: "heart", color: "#16A085" },
      { name: "Shopping", icon: "cart", color: "#FF6D00" }
    ];
    var catIds = cats.map(function (c) {
      var rec = {
        category_id: IdGenerator.category(), parent_category_id: "",
        name: c.name, type: "EXPENSE", icon: c.icon, color: c.color,
        monthly_budget: "", sort_order: 0, status: "ACTIVE", created_at: now
      };
      appendRow("categories", rec);
      return rec.category_id;
    });

    var sources = ["Salary", "Freelance", "Gift", "Refund", "Dividend", "Bonus", "Interest", "Other"];
    sources.forEach(function (s, i) {
      appendRow("income_sources", {
        income_source_id: IdGenerator.incomeSource(), name: s,
        type: s === "Salary" ? "EMPLOYMENT" : s === "Freelance" ? "FREELANCE" : s === "Gift" ? "GIFT"
              : s === "Refund" ? "REFUND" : s === "Dividend" ? "DIVIDEND" : s === "Bonus" ? "BONUS"
              : s === "Interest" ? "INTEREST" : "OTHER",
        icon: "", color: "#34A853", sort_order: i, status: "ACTIVE", created_at: now
      });
    });

    // default budgets for food/transport/utilities this month
    var period = monthStamp(new Date());
    var budgets = [
      { cat: catIds[0], amount: 400 },
      { cat: catIds[1], amount: 200 },
      { cat: catIds[2], amount: 150 }
    ];
    budgets.forEach(function (b) {
      appendRow("budgets", {
        budget_id: IdGenerator.budget(), category_id: b.cat, period: period,
        budget_amount: b.amount, currency: SettingsService.getRaw("base_currency"),
        status: "ACTIVE", created_at: now
      });
    });

    // a couple of sample goals
    appendRow("goals", {
      goal_id: IdGenerator.goal(), name: "Emergency Fund", goal_type: "EMERGENCY_FUND",
      target_amount: 3000, currency: SettingsService.getRaw("base_currency"),
      linked_account_id: accIds[2], current_amount: "", deadline: "",
      priority: "HIGH", monthly_contribution: 200, projected_completion: "",
      status: "ACTIVE", created_at: now
    });
  }
};
