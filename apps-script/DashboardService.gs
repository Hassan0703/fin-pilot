/**
 * FinPilot v0 — Dashboard Service.
 *
 * Builds the executive dashboard layout (KPI cards, progress bars, warnings,
 * recent activity) and installs charts. All values are FORMULAS over the tables;
 * nothing is hand-typed on the dashboard.
 */

var DASHBOARD = {
  theme: {
    bg: "#1E1E24",
    card: "#2A2A33",
    text: "#F5F5F7",
    muted: "#9A9AA5",
    accent: "#4F8CFF",
    good: "#34C759",
    warn: "#FFD60A",
    bad: "#FF453A"
  }
};

var DashboardService = {
  /** Builds the layout grid and writes formula cells. */
  buildLayout: function () {
    var ss = openDb();
    var sheet = ss.getSheetByName("dashboard") || ss.insertSheet("dashboard");
    sheet.clear();

    // Title block
    sheet.getRange("A1").setValue("FinPilot");
    sheet.getRange("A2").setValue("Executive Dashboard");
    sheet.getRange("C2").setFormula("=\"Last updated \"&TEXT(NOW(),\"yyyy-mm-dd hh:mm\")");

    // KPI cards (row 5-7): labels + values
    var kpis = [
      { label: "Net Worth", formula: DashboardService.fNetWorth(), acc: true, col: "B" },
      { label: "Income (this month)", formula: DashboardService.fMetric("INCOME"), acc: false, col: "D" },
      { label: "Expenses (this month)", formula: DashboardService.fMetric("EXPENSE"), acc: false, col: "F" },
      { label: "Savings Rate", formula: DashboardService.fMetric("SAVINGS_RATE"), pct: true, col: "H" },
      { label: "Burn Rate (avg/mo)", formula: DashboardService.fBurn(), col: "J" }
    ];
    kpis.forEach(function (k, i) {
      var col = k.col || String.fromCharCode(66 + i * 2);
      sheet.getRange(col + "5").setValue(k.label);
      var cell = sheet.getRange(col + "6");
      cell.setFormula(k.formula);
      if (k.pct) cell.setNumberFormat("0.0%");
      else if (k.acc) cell.setNumberFormat("#,##0.00");
      else cell.setNumberFormat("#,##0.00");
    });

    // Budget progress (rows 10-14): category, budget, used, remaining, pct, status
    sheet.getRange("A10").setValue("Budget Watch");
    ["Category", "Budget", "Used", "Remaining", "Used %", "Status"].forEach(function (h, i) {
      sheet.getRange(11, i + 1).setValue(h);
    });
    for (var b = 0; b < 8; b++) {
      var r = 12 + b;
      var br = 2 + b; // budgets row
      sheet.getRange(r, 1).setFormula(
        '=IFERROR(VLOOKUP(budgets!$B' + br + ',{categories!$A$2:$A,categories!$C$2:$C},2,FALSE),"")');
      sheet.getRange(r, 2).setFormula('=IFERROR(budgets!$D' + br + ',"")');
      sheet.getRange(r, 3).setFormula(
        '=IFERROR(SUMIFS(transactions!$E$2:$E,transactions!$J$2:$J,budgets!$B' + br +
        ',transactions!$D$2:$D,"EXPENSE",transactions!$C$2:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01"),transactions!$C$2:$C,"<="&EOMONTH(TODAY(),0)),0)');
      sheet.getRange(r, 4).setFormula('=IFERROR($B' + r + '-$C' + r + ',"")');
      sheet.getRange(r, 5).setFormula('=IFERROR(IF($B' + r + '=0,0,$C' + r + '/$B' + r + '),"")').setNumberFormat("0.0%");
      sheet.getRange(r, 6).setFormula(
        '=IF($B' + r + '="","",IF($E' + r + '>=' + DashboardService.budgetOverFormula() + ',"OVER",IF($E' + r + '>=' + DashboardService.budgetAlertFormula() + ',"WARN","OK")))');
    }

    // Goal progress (rows 16-20)
    sheet.getRange("A16").setValue("Goals");
    ["Goal", "Progress", "Target", "Pct", "Projected"].forEach(function (h, i) {
      sheet.getRange(17, i + 1).setValue(h);
    });
    for (var g = 0; g < 6; g++) {
      var rg = 18 + g;
      sheet.getRange(rg, 1).setFormula('=IFERROR(goals!B' + (2 + g) + ',"")');
      sheet.getRange(rg, 2).setFormula('=IFERROR(goals!G' + (2 + g) + ',"")');
      sheet.getRange(rg, 3).setFormula('=IFERROR(goals!D' + (2 + g) + ',"")');
      sheet.getRange(rg, 4).setFormula(
        '=IFERROR(IF(goals!D' + (2 + g) + '=0,0,goals!G' + (2 + g) + '/goals!D' + (2 + g) + '),"")').setNumberFormat("0.0%");
      sheet.getRange(rg, 5).setFormula('=IFERROR(goals!K' + (2 + g) + ',"")');
    }

    // Recent activity (rows 22-29)
    sheet.getRange("A22").setValue("Recent Activity");
    ["Date", "Type", "Amount", "Account", "Category", "Note"].forEach(function (h, i) {
      sheet.getRange(23, i + 1).setValue(h);
    });
    var recent = sheet.getRange(24, 1, 6, 6);
    recent.setFormula(
      '=QUERY({transactions!$C$2:$C,transactions!$D$2:$D,transactions!$E$2:$E,transactions!$G$2:$G,transactions!$J$2:$J,transactions!$M$2:$M},"SELECT * ORDER BY Col1 DESC LIMIT 6",0)');

    // Warnings panel (row 31)
    sheet.getRange("A31").setValue("Warnings");
    sheet.getRange("A32").setFormula(
      '=IFERROR(IF(SUMIFS(transactions!$E:$E,transactions!$D:$D,"EXPENSE",transactions!$C:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01")) > ' +
      'SUM(categories!$G:$G),"You exceeded your total budget this month","All budgets on track"),"")');

    // Financial Score (rows 34-40)
    sheet.getRange("A34").setValue("Financial Score");
    for (var s = 0; s < 6; s++) {
      var rs = 35 + s;
      sheet.getRange(rs, 1).setFormula('=IFERROR(financial_score!B' + (2 + s) + ',"")');
      sheet.getRange(rs, 2).setFormula('=IFERROR(financial_score!D' + (2 + s) + ',"")');
      sheet.getRange(rs, 3).setFormula('=IFERROR(financial_score!F' + (2 + s) + ',"")');
      sheet.getRange(rs, 4).setFormula('=IFERROR(financial_score!H' + (2 + s) + ',"")');
    }

    // Roadmap (rows 42-48)
    sheet.getRange("A42").setValue("Roadmap");
    ["Stage", "Status", "Progress", "Recommendation"].forEach(function (h, i) {
      sheet.getRange(43, i + 1).setValue(h);
    });
    for (var st = 0; st < 7; st++) {
      var rst = 44 + st;
      sheet.getRange(rst, 1).setFormula('=IFERROR(roadmap!C' + (2 + st) + ',"")');
      sheet.getRange(rst, 2).setFormula('=IFERROR(roadmap!F' + (2 + st) + ',"")');
      sheet.getRange(rst, 3).setFormula('=IFERROR(roadmap!G' + (2 + st) + ',"")');
      sheet.getRange(rst, 4).setFormula('=IFERROR(roadmap!H' + (2 + st) + ',"")');
    }

    FormattingService.styleDashboard(sheet);
    return sheet;
  },

  /** Threshold from settings used inside budget status formulas. */
  budgetAlertFormula: function () {
    return 'IFERROR(VALUE(VLOOKUP("budget_alert_threshold",settings!$A:$B,2,FALSE)),0.8)';
  },

  /** Over-budget threshold from settings (default 1.0 = 100% of budget). */
  budgetOverFormula: function () {
    return 'IFERROR(VALUE(VLOOKUP("budget_over_threshold",settings!$A:$B,2,FALSE)),1)';
  },

  /** Net worth = plain sum of balances; liabilities are stored negative, never flipped. */
  fNetWorth: function () {
    return '=SUM(accounts!$F$2:$F)';
  },

  /** Total income/expense for the current month from the ledger. */
  fMetric: function (metric) {
    var type = metric === "INCOME" ? "INCOME" : metric === "EXPENSE" ? "EXPENSE" : "";
    if (type) {
      return '=SUMIFS(transactions!$E:$E,transactions!$D:$D,"' + type +
        '",transactions!$C:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01"),transactions!$C:$C,"<="&EOMONTH(TODAY(),0))';
    }
    // savings rate (current calendar month only)
    return '=IFERROR((SUMIFS(transactions!$E:$E,transactions!$D:$D,"INCOME",transactions!$C:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01"),transactions!$C:$C,"<="&EOMONTH(TODAY(),0)) - ' +
      'SUMIFS(transactions!$E:$E,transactions!$D:$D,"EXPENSE",transactions!$C:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01"),transactions!$C:$C,"<="&EOMONTH(TODAY(),0))) / ' +
      'SUMIFS(transactions!$E:$E,transactions!$D:$D,"INCOME",transactions!$C:$C,">="&DATEVALUE(TEXT(TODAY(),"YYYY-MM")&"-01"),transactions!$C:$C,"<="&EOMONTH(TODAY(),0)),0)';
  },

  fBurn: function () {
    // Trailing average MONTHLY burn: group POSTED expenses by month and average
    // the last `burn_rate_months` month-totals (default 3). Averaging the last
    // N expense amounts directly would report per-transaction spend, not a burn.
    return '=IFERROR(AVERAGE(QUERY(QUERY({transactions!$C:$C,transactions!$E:$E,transactions!$D:$D},"SELECT YEAR(Col1), MONTH(Col1), SUM(Col2) WHERE Col3=\'EXPENSE\' AND Col1 IS NOT NULL GROUP BY YEAR(Col1), MONTH(Col1) LABEL SUM(Col2) \'\'",0),"SELECT Col3 ORDER BY Col1 DESC, Col2 DESC LIMIT ' + (Number(SettingsService.get("burn_rate_months")) || 3) + '",0)),0)';
  },

  /** Installs the charts: income/expense bar, category donut, net worth line. */
  installCharts: function () {
    var ss = openDb();
    var sheet = ss.getSheetByName("dashboard") || DashboardService.buildLayout();

    // Remove previously installed charts so re-runs never stack duplicates.
    try {
      sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });
    } catch (e) { Logger.log("chart cleanup: " + e.message); }

    // Income vs Expense bar — sourced from monthly_analytics (generated facts)
    try {
      sheet.getRange("A51").setValue("Income vs Expense (last 6 months)");
      var q1 = sheet.getRange("A52");
      q1.setFormula(
        '=QUERY({monthly_analytics!$B:$B,monthly_analytics!$C:$C,monthly_analytics!$F:$F},"SELECT Col1, SUM(Col3) WHERE Col2=\'INCOME\' OR Col2=\'EXPENSE\' GROUP BY Col1 LABEL SUM(Col3) \'\' ORDER BY Col1 DESC LIMIT 12",0)');
      var chart = sheet.newChart()
        .asColumnChart()
        .addRange(q1)
        .setOption("title", "Income vs Expense")
        .setPosition(55, 1, 0, 0)
        .setOption("colors", ["#34C759", "#FF453A"])
        .build();
      sheet.insertChart(chart);
    } catch (e) { Logger.log("chart1: " + e.message); }

    // Net worth line — from NET_WORTH facts
    try {
      var q2 = sheet.getRange("H52");
      q2.setFormula(
        '=QUERY({monthly_analytics!$B:$B,monthly_analytics!$C:$C,monthly_analytics!$F:$F},"SELECT Col1, Col3 WHERE Col2=\'NET_WORTH\' ORDER BY Col1 DESC LIMIT 12",0)');
      var chart2 = sheet.newChart()
        .asLineChart()
        .addRange(q2)
        .setOption("title", "Net Worth Trend")
        .setPosition(55, 7, 0, 0)
        .setOption("colors", ["#4F8CFF"])
        .build();
      sheet.insertChart(chart2);
    } catch (e) { Logger.log("chart2: " + e.message); }
  },

  onLedgerChanged: function () {
    // Formulas recalculate automatically; nothing to persist here.
  },

  apiSummary: function () {
    var ss = openDb();
    var sheet = ss.getSheetByName("dashboard");
    if (!sheet) sheet = DashboardService.buildLayout();
    return {
      data: {
        net_worth: DashboardService.readCell(sheet, "B6"),
        income: DashboardService.readCell(sheet, "D6"),
        expense: DashboardService.readCell(sheet, "F6"),
        savings_rate: DashboardService.readCell(sheet, "H6"),
        burn_rate: DashboardService.readCell(sheet, "J6"),
        schema_version: SettingsService.getRaw("schema_version")
      }
    };
  },

  readCell: function (sheet, a1) {
    if (!sheet) return null;
    return sheet.getRange(a1).getValue();
  }
};

/** Opens the dashboard sheet. */
function gotoDashboard() {
  var ss = openDb();
  var sheet = ss.getSheetByName("dashboard");
  if (!sheet) sheet = DashboardService.buildLayout();
  ss.setActiveSheet(sheet);
  ss.setActiveRange(sheet.getRange("A1"));
}
