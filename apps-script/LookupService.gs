/**
 * FinPilot v0 — Lookup Service (dictionaries).
 *
 * No hardcoded dropdowns. Every enum/catalog value lives in the `lookups` table,
 * discriminated by lookup_group. Adding a value = adding a row. No code changes.
 */

var DEFAULT_LOOKUPS = [
  // transaction types
  ["transaction_type", "EXPENSE", "Expense", 1],
  ["transaction_type", "INCOME", "Income", 2],
  ["transaction_type", "TRANSFER", "Transfer", 3],
  // analytics metrics (monthly_analytics.metric column)
  ["metric", "INCOME", "Income", 1],
  ["metric", "EXPENSE", "Expense", 2],
  ["metric", "SAVINGS", "Savings", 3],
  ["metric", "CASH_FLOW", "Cash Flow", 4],
  ["metric", "SAVINGS_RATE", "Savings Rate", 5],
  ["metric", "BURN_RATE", "Burn Rate", 6],
  ["metric", "AVG_DAILY_SPEND", "Avg Daily Spend", 7],
  ["metric", "NET_WORTH", "Net Worth", 8],
  ["metric", "CATEGORY_SPEND", "Category Spend", 9],
  ["metric", "MERCHANT_SPEND", "Merchant Spend", 10],
  ["metric", "ACCOUNT_BALANCE", "Account Balance", 11],
  ["metric", "TREND_INCOME", "Income Trend", 12],
  ["metric", "TREND_EXPENSE", "Expense Trend", 13],
  ["metric", "TREND_NET_WORTH", "Net Worth Trend", 14],
  // account types
  ["account_type", "CASH", "Cash", 1],
  ["account_type", "BANK", "Bank", 2],
  ["account_type", "WALLET", "Wallet", 3],
  ["account_type", "SAVINGS", "Savings", 4],
  ["account_type", "INVESTMENT", "Investment", 5],
  ["account_type", "BUSINESS", "Business", 6],
  ["account_type", "CREDIT_CARD", "Credit Card", 7],
  ["account_type", "LOAN", "Loan", 8],
  ["account_type", "CRYPTO", "Crypto", 9],
  // currencies
  ["currency", "USD", "US Dollar", 1, '{"symbol":"$"}'],
  ["currency", "EUR", "Euro", 2, '{"symbol":"€"}'],
  ["currency", "GBP", "British Pound", 3, '{"symbol":"£"}'],
  ["currency", "INR", "Indian Rupee", 4, '{"symbol":"₹"}'],
  ["currency", "AED", "UAE Dirham", 5, '{"symbol":"د.إ"}'],
  ["currency", "PKR", "Pakistani Rupee", 6, '{"symbol":"₨"}'],
  ["currency", "SAR", "Saudi Riyal", 7, '{"symbol":"﷼"}'],
  ["currency", "CAD", "Canadian Dollar", 8, '{"symbol":"$"}'],
  ["currency", "AUD", "Australian Dollar", 9, '{"symbol":"$"}'],
  ["currency", "JPY", "Japanese Yen", 10, '{"symbol":"¥"}'],
  ["currency", "CNY", "Chinese Yuan", 11, '{"symbol":"¥"}'],
  // countries
  ["country", "US", "United States", 1],
  ["country", "GB", "United Kingdom", 2],
  ["country", "IN", "India", 3],
  ["country", "AE", "United Arab Emirates", 4],
  ["country", "PK", "Pakistan", 5],
  ["country", "SA", "Saudi Arabia", 6],
  ["country", "CA", "Canada", 7],
  ["country", "AU", "Australia", 8],
  ["country", "EU", "European Union", 9],
  // months
  ["month", "01", "January", 1], ["month", "02", "February", 2],
  ["month", "03", "March", 3], ["month", "04", "April", 4],
  ["month", "05", "May", 5], ["month", "06", "June", 6],
  ["month", "07", "July", 7], ["month", "08", "August", 8],
  ["month", "09", "September", 9], ["month", "10", "October", 10],
  ["month", "11", "November", 11], ["month", "12", "December", 12],
  // icons (referenced by icon code)
  ["icon", "bank", "Bank", 1], ["icon", "cash", "Cash", 2],
  ["icon", "wallet", "Wallet", 3], ["icon", "piggy", "Piggy Bank", 4],
  ["icon", "chart", "Chart", 5], ["icon", "briefcase", "Briefcase", 6],
  ["icon", "card", "Credit Card", 7], ["icon", "crypto", "Crypto", 8],
  ["icon", "cart", "Cart", 9], ["icon", "food", "Food", 10],
  ["icon", "home", "Home", 11], ["icon", "car", "Car", 12],
  ["icon", "plane", "Plane", 13], ["icon", "gift", "Gift", 14],
  ["icon", "star", "Star", 15], ["icon", "heart", "Heart", 16],
  // colors
  ["color", "#4285F4", "Blue", 1], ["color", "#34A853", "Green", 2],
  ["color", "#FBBC04", "Yellow", 3], ["color", "#EA4335", "Red", 4],
  ["color", "#9C27B0", "Purple", 5], ["color", "#FF6D00", "Orange", 6],
  ["color", "#00ACC1", "Teal", 7], ["color", "#5F6368", "Grey", 8],
  ["color", "#212121", "Dark", 9], ["color", "#FFFFFF", "White", 10],
  ["color", "#F4B400", "Amber", 11], ["color", "#16A085", "Emerald", 12],
  // statuses
  ["status", "ACTIVE", "Active", 1],
  ["status", "INACTIVE", "Inactive", 2],
  ["status", "ARCHIVED", "Archived", 3],
  ["status", "PENDING", "Pending", 4],
  ["status", "POSTED", "Posted", 5],
  ["status", "VOID", "Void", 6],
  ["status", "REJECTED", "Rejected", 7],
  ["status", "COMPLETED", "Completed", 8],
  ["status", "PAUSED", "Paused", 9],
  ["status", "ON_TRACK", "On Track", 10],
  ["status", "WARNING", "Warning", 11],
  ["status", "FAIL", "Fail", 12],
  ["status", "LOCKED", "Locked", 13],
  ["status", "CURRENT", "Current", 14],
  ["status", "ACTIVE_TRANSACTION", "Active", 15],
  // tags
  ["tag", "groceries", "Groceries", 1],
  ["tag", "food", "Food & Dining", 2],
  ["tag", "transport", "Transport", 3],
  ["tag", "utilities", "Utilities", 4],
  ["tag", "entertainment", "Entertainment", 5],
  ["tag", "health", "Health", 6],
  ["tag", "education", "Education", 7],
  ["tag", "travel", "Travel", 8],
  ["tag", "shopping", "Shopping", 9],
  ["tag", "salary", "Salary", 10],
  ["tag", "freelance", "Freelance", 11],
  ["tag", "investment", "Investment", 12],
  // frequency
  ["frequency", "DAILY", "Daily", 1],
  ["frequency", "WEEKLY", "Weekly", 2],
  ["frequency", "MONTHLY", "Monthly", 3],
  ["frequency", "QUARTERLY", "Quarterly", 4],
  ["frequency", "YEARLY", "Yearly", 5],
  // payment methods
  ["payment_method", "CASH", "Cash", 1],
  ["payment_method", "CARD", "Card", 2],
  ["payment_method", "UPI", "UPI", 3],
  ["payment_method", "BANK_TRANSFER", "Bank Transfer", 4],
  ["payment_method", "WALLET", "Wallet", 5],
  ["payment_method", "CRYPTO", "Crypto", 6],
  // income source types
  ["income_source_type", "EMPLOYMENT", "Employment", 1],
  ["income_source_type", "FREELANCE", "Freelance", 2],
  ["income_source_type", "BUSINESS", "Business", 3],
  ["income_source_type", "PASSIVE", "Passive", 4],
  ["income_source_type", "GIFT", "Gift", 5],
  ["income_source_type", "REFUND", "Refund", 6],
  ["income_source_type", "DIVIDEND", "Dividend", 7],
  ["income_source_type", "BONUS", "Bonus", 8],
  ["income_source_type", "INTEREST", "Interest", 9],
  ["income_source_type", "OTHER", "Other", 10],
  // goal types
  ["goal_type", "EMERGENCY_FUND", "Emergency Fund", 1],
  ["goal_type", "SAVINGS", "Savings", 2],
  ["goal_type", "ASSET", "Asset", 3],
  ["goal_type", "INVESTMENT", "Investment", 4],
  ["goal_type", "VACATION", "Vacation", 5],
  ["goal_type", "DEBT_FREE", "Debt Free", 6],
  ["goal_type", "CUSTOM", "Custom", 7],
  // priority
  ["priority", "HIGH", "High", 1],
  ["priority", "MEDIUM", "Medium", 2],
  ["priority", "LOW", "Low", 3],
  // source
  ["source", "SHORTCUT", "Shortcut", 1],
  ["source", "API", "API", 2],
  ["source", "SYSTEM", "System", 3],
  ["source", "IMPORT", "Import", 4]
];

var LookupService = {
  ensureDefaults: function () {
    var existing = {};
    readTable("lookups").forEach(function (r) {
      existing[r.lookup_group + "|" + r.code] = true;
    });
    DEFAULT_LOOKUPS.forEach(function (l) {
      var key = l[0] + "|" + l[1];
      if (existing[key]) return;
      appendRow("lookups", {
        lookup_id: IdGenerator.lookup(),
        lookup_group: l[0],
        code: l[1],
        label: l[2],
        display_order: l[3] || 0,
        is_active: true,
        meta: l[4] || ""
      });
    });
  },

  /** All active codes in a group. */
  codes: function (group) {
    return readTable("lookups")
      .filter(function (r) { return r.lookup_group === group && isTrue(r.is_active); })
      .map(function (r) { return String(r.code); });
  },

  /** True if code exists and is active in the group. */
  has: function (group, code) {
    return LookupService.codes(group).indexOf(String(code)) >= 0;
  },

  apiList: function (body) {
    if (body.group) return { data: LookupService.codes(body.group) };
    var groups = {};
    readTable("lookups").forEach(function (r) {
      if (!isTrue(r.is_active)) return;
      groups[r.lookup_group] = groups[r.lookup_group] || [];
      groups[r.lookup_group].push({ code: r.code, label: r.label });
    });
    return { data: groups };
  }
};
