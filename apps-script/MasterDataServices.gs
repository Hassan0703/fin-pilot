/**
 * FinPilot v0 — Account Service.
 *
 * Account is an aggregate. It can only be created/updated through this service.
 * The current_balance column is DERIVED (formula), never hand-entered.
 */

var AccountService = {
  apiCreate: function (body) {
    return withLock(function () {
      AccountService.validate(body);

      var now = isoNow();
      var status = String(body.status || "ACTIVE").toUpperCase();
      var rec = {
        account_id: IdGenerator.account(),
        name: String(body.name).trim(),
        type: String(body.type).toUpperCase(),
        currency: String(body.currency || SettingsService.getRaw("base_currency")).toUpperCase(),
        opening_balance: Number(body.opening_balance || 0),
        current_balance: "", // derived by formula
        color: body.color || "#4285F4",
        icon: body.icon || "bank",
        status: status,
        is_credit: (body.is_credit === true || String(body.is_credit).toUpperCase() === "TRUE") ? "TRUE" : "FALSE",
        note: String(body.note || ""),
        created_date: body.created_date || todayStamp(),
        created_at: now
      };
      var row = appendRow("accounts", rec);
      FormattingService.applyAccountFormula(row);
      emit("account.created", { account: rec });
      return { data: rec };
    });
  },

  validate: function (body) {
    var errors = [];
    if (!body.name || !String(body.name).trim()) errors.push("name is required.");
    if (!body.type) errors.push("type is required.");
    else if (!LookupService.has("account_type", String(body.type).toUpperCase())) {
      errors.push("unknown account type '" + body.type + "'.");
    }
    var cur = body.currency || SettingsService.getRaw("base_currency");
    if (!LookupService.has("currency", String(cur).toUpperCase())) {
      errors.push("unknown currency '" + cur + "'.");
    }
    var status = String(body.status || "ACTIVE").toUpperCase();
    if (["ACTIVE", "INACTIVE", "ARCHIVED"].indexOf(status) < 0) {
      errors.push("status must be ACTIVE, INACTIVE or ARCHIVED.");
    }
    if (errors.length) throw new ValidationError(errors.map(function (m) {
      return { rule: "ACCOUNT_INVALID", message: m };
    }));
  },

  apiList: function (body) {
    var rows = readTable("accounts");
    if (body.status) rows = rows.filter(function (r) {
      return String(r.status) === String(body.status).toUpperCase();
    });
    return { data: rows };
  },

  apiGet: function (body) {
    if (!body.account_id) throw new Error("account.get requires 'account_id'.");
    var rows = readTable("accounts");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].account_id) === String(body.account_id)) return { data: rows[i] };
    }
    throw new Error("Account not found: " + body.account_id);
  }
};

/**
 * FinPilot v0 — Category Service.
 * Supports parent/sub-categories via parent_category_id (unlimited depth).
 */
var CategoryService = {
  apiCreate: function (body) {
    return withLock(function () {
      var errors = [];
      if (!body.name) errors.push("name is required.");
      var type = String(body.type || "EXPENSE").toUpperCase();
      if (["EXPENSE", "INCOME"].indexOf(type) < 0) errors.push("type must be EXPENSE or INCOME.");
      if (body.parent_category_id) {
        var found = findRow("categories", "category_id", body.parent_category_id);
        if (!found) errors.push("parent_category_id does not exist.");
      }
      if (errors.length) throw new ValidationError(errors.map(function (m) {
        return { rule: "CATEGORY_INVALID", message: m };
      }));

      var rec = {
        category_id: IdGenerator.category(),
        parent_category_id: body.parent_category_id || "",
        name: String(body.name).trim(),
        type: type,
        icon: body.icon || "",
        color: body.color || "#4285F4",
        monthly_budget: body.monthly_budget ? Number(body.monthly_budget) : "",
        sort_order: Number(body.sort_order || 0),
        status: String(body.status || "ACTIVE").toUpperCase(),
        created_at: isoNow()
      };
      appendRow("categories", rec);
      return { data: rec };
    });
  },

  apiList: function (body) {
    var rows = readTable("categories");
    if (body.type) rows = rows.filter(function (r) { return String(r.type) === String(body.type).toUpperCase(); });
    if (body.status) rows = rows.filter(function (r) { return String(r.status) === String(body.status).toUpperCase(); });
    return { data: rows };
  }
};

/**
 * FinPilot v0 — Income Source Service.
 */
var IncomeSourceService = {
  apiCreate: function (body) {
    return withLock(function () {
      var errors = [];
      if (!body.name || !String(body.name).trim()) errors.push("name is required.");
      var type = String(body.type || "OTHER").toUpperCase();
      if (!LookupService.has("income_source_type", type)) {
        errors.push("unknown income source type '" + type + "'.");
      }
      if (errors.length) throw new ValidationError(errors.map(function (m) {
        return { rule: "INCOME_SOURCE_INVALID", message: m };
      }));
      var rec = {
        income_source_id: IdGenerator.incomeSource(),
        name: String(body.name).trim(),
        type: type,
        icon: body.icon || "",
        color: body.color || "#34A853",
        sort_order: Number(body.sort_order || 0),
        status: String(body.status || "ACTIVE").toUpperCase(),
        created_at: isoNow()
      };
      appendRow("income_sources", rec);
      return { data: rec };
    });
  },

  apiList: function (body) {
    var rows = readTable("income_sources");
    if (body.status) rows = rows.filter(function (r) {
      return String(r.status) === String(body.status).toUpperCase();
    });
    return { data: rows };
  }
};

/**
 * FinPilot v0 — Budget Service.
 * Monthly budgets by category. Effective budget falls back to category default.
 */
var BudgetService = {
  apiCreate: function (body) {
    return withLock(function () {
      var errors = [];
      if (!body.category_id) errors.push("category_id is required.");
      if (!body.period) errors.push("period (YYYY-MM) is required.");
      else { try { new Period(body.period); } catch (e) { errors.push(e.message); } }
      var amt = Number(body.budget_amount);
      if (!isFinite(amt) || amt <= 0) errors.push("budget_amount must be > 0.");
      var cur = String(body.currency || SettingsService.getRaw("base_currency")).toUpperCase();
      if (!LookupService.has("currency", cur)) errors.push("unknown currency '" + cur + "'.");
      if (errors.length) throw new ValidationError(errors.map(function (m) {
        return { rule: "BUDGET_INVALID", message: m };
      }));

      var rec = {
        budget_id: IdGenerator.budget(),
        category_id: String(body.category_id),
        period: String(body.period),
        budget_amount: amt,
        currency: cur,
        status: String(body.status || "ACTIVE").toUpperCase(),
        created_at: isoNow()
      };
      appendRow("budgets", rec);
      return { data: rec };
    });
  },

  apiList: function (body) {
    var rows = readTable("budgets");
    if (body.period) rows = rows.filter(function (r) { return String(r.period) === String(body.period); });
    if (body.category_id) rows = rows.filter(function (r) { return String(r.category_id) === String(body.category_id); });
    return { data: rows };
  },

  /**
   * Effective budget for a category+period: explicit budget row wins,
   * else the category's default monthly_budget.
   */
  effective: function (categoryId, period, budgetRows, categoryRows) {
    var budgets = budgetRows || readTable("budgets");
    for (var i = 0; i < budgets.length; i++) {
      if (String(budgets[i].category_id) === String(categoryId) &&
          String(budgets[i].period) === String(period)) {
        return Number(budgets[i].budget_amount);
      }
    }
    var cats = categoryRows || readTable("categories");
    for (var j = 0; j < cats.length; j++) {
      if (String(cats[j].category_id) === String(categoryId)) {
        var d = Number(cats[j].monthly_budget);
        return isFinite(d) && d > 0 ? d : 0;
      }
    }
    return 0;
  }
};

/**
 * FinPilot v0 — Goal Service.
 * current_amount and projected_completion are DERIVED (never hand-entered).
 */
var GoalService = {
  apiCreate: function (body) {
    return withLock(function () {
      var errors = [];
      if (!body.name) errors.push("name is required.");
      var target = Number(body.target_amount);
      if (!isFinite(target) || target <= 0) errors.push("target_amount must be > 0.");
      if (body.linked_account_id && !findRow("accounts", "account_id", body.linked_account_id)) {
        errors.push("linked_account_id does not exist.");
      }
      var priority = String(body.priority || "MEDIUM").toUpperCase();
      if (!LookupService.has("priority", priority)) errors.push("unknown priority '" + priority + "'.");
      var cur = String(body.currency || SettingsService.getRaw("base_currency")).toUpperCase();
      if (!LookupService.has("currency", cur)) errors.push("unknown currency '" + cur + "'.");
      var deadline = "";
      if (body.deadline) {
        try { deadline = normalizeDate(body.deadline); }
        catch (e) { errors.push("deadline is not a valid date: " + e.message); }
      }
      if (errors.length) throw new ValidationError(errors.map(function (m) {
        return { rule: "GOAL_INVALID", message: m };
      }));

      var rec = {
        goal_id: IdGenerator.goal(),
        name: String(body.name).trim(),
        goal_type: String(body.goal_type || "CUSTOM").toUpperCase(),
        target_amount: target,
        currency: cur,
        linked_account_id: body.linked_account_id || "",
        current_amount: "", // derived by formula from linked account
        deadline: deadline,
        priority: priority,
        monthly_contribution: Number(body.monthly_contribution || 0),
        projected_completion: "", // derived
        status: String(body.status || "ACTIVE").toUpperCase(),
        created_at: isoNow()
      };
      var row = appendRow("goals", rec);
      FormattingService.applyGoalFormulas(row);
      return { data: rec };
    });
  },

  apiList: function (body) {
    var rows = readTable("goals");
    if (body.status) rows = rows.filter(function (r) {
      return String(r.status) === String(body.status).toUpperCase();
    });
    return { data: rows };
  }
};

/**
 * FinPilot v0 — Recurring Service.
 * Stores rules; the engine materializes due rules into the ledger.
 */
var RecurringService = {
  apiCreate: function (body) {
    return withLock(function () {
      var errors = [];
      if (!body.name) errors.push("name is required.");
      var type = String(body.type || "").toUpperCase();
      if (["EXPENSE", "INCOME"].indexOf(type) < 0) errors.push("type must be EXPENSE or INCOME.");
      var amt = Number(body.amount);
      if (!isFinite(amt) || amt <= 0) errors.push("amount must be > 0.");
      var freq = String(body.frequency || "").toUpperCase();
      if (!LookupService.has("frequency", freq)) errors.push("unknown frequency '" + freq + "'.");
      var cur = String(body.currency || SettingsService.getRaw("base_currency")).toUpperCase();
      if (!LookupService.has("currency", cur)) errors.push("unknown currency '" + cur + "'.");
      var dom = body.day_of_month ? Number(body.day_of_month) : "";
      if (dom !== "" && (dom < 1 || dom > 31)) errors.push("day_of_month must be 1-31.");
      var dow = body.day_of_week ? Number(body.day_of_week) : "";
      if (dow !== "" && (dow < 1 || dow > 7)) errors.push("day_of_week must be 1 (Monday) - 7 (Sunday).");
      var startDate = body.start_date || todayStamp();
      var endDate = "";
      try {
        startDate = normalizeDate(startDate);
        if (body.end_date) endDate = normalizeDate(body.end_date);
      } catch (e) {
        errors.push("invalid date: " + e.message);
      }
      if (errors.length) throw new ValidationError(errors.map(function (m) {
        return { rule: "RECURRING_INVALID", message: m };
      }));

      var rec = {
        recurring_id: IdGenerator.recurring(),
        name: String(body.name).trim(),
        type: type,
        amount: amt,
        currency: cur,
        frequency: freq,
        day_of_month: dom,
        day_of_week: dow,
        start_date: startDate,
        end_date: endDate,
        next_run: RecurringService.computeNextRun(body, type, startDate),
        last_run: "",
        account_id: body.account_id || "",
        from_account_id: body.from_account_id || "",
        to_account_id: body.to_account_id || "",
        category_id: body.category_id || "",
        income_source_id: body.income_source_id || "",
        status: String(body.status || "ACTIVE").toUpperCase(),
        created_at: isoNow()
      };
      appendRow("recurring", rec);
      return { data: rec };
    });
  },

  apiList: function (body) {
    var rows = readTable("recurring");
    if (body.status) rows = rows.filter(function (r) {
      return String(r.status) === String(body.status).toUpperCase();
    });
    return { data: rows };
  },

  /** Normalizes day_of_week (1=Mon … 7=Sun); null when absent/invalid. */
  normalizeDayOfWeek: function (v) {
    if (v === "" || v === undefined || v === null) return null;
    var n = Number(v);
    return isFinite(n) && n >= 1 && n <= 7 ? n : null;
  },

  /** Normalizes day_of_month (1…31); null when absent/invalid. */
  normalizeDayOfMonth: function (v) {
    if (v === "" || v === undefined || v === null) return null;
    var n = Number(v);
    return isFinite(n) && n >= 1 && n <= 31 ? n : null;
  },

  /** Weekday in the project convention (1=Mon … 7=Sun). */
  utcWeekday: function (d) {
    var wd = d.getUTCDay();
    return wd === 0 ? 7 : wd;
  },

  /** Strictly-after date landing on the given weekday (1=Mon … 7=Sun). */
  nextWeekdayAfter: function (from, targetDOW) {
    var delta = targetDOW - RecurringService.utcWeekday(from);
    if (delta <= 0) delta += 7;
    var d = new Date(from.getTime());
    d.setUTCDate(d.getUTCDate() + delta);
    return d;
  },

  /** Clamps a day-of-month into the month that `monthFirst` is the 1st of. */
  clampDayOfMonth: function (monthFirst, dom) {
    var last = new Date(Date.UTC(monthFirst.getUTCFullYear(),
      monthFirst.getUTCMonth() + 1, 0)).getUTCDate();
    var day = Math.min(Math.max(dom, 1), last);
    return new Date(Date.UTC(monthFirst.getUTCFullYear(), monthFirst.getUTCMonth(), day));
  },

  /**
   * Next occurrence strictly after fromDate. Honors day_of_week (WEEKLY) and
   * day_of_month (MONTHLY/QUARTERLY/YEARLY). All dates are computed in UTC —
   * the project's canonical timezone — so DST cannot cause drift. When the
   * target month is shorter than the day (e.g. day 31 → February) the run is
   * clamped to the last valid day; leap years resolve deterministically.
   */
  computeNextRun: function (rule, type, fromDate) {
    var from = new Date(String(fromDate) + "T00:00:00Z");
    var freq = String(rule.frequency || "").toUpperCase();
    var next;
    if (freq === "DAILY") {
      next = new Date(from.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
    } else if (freq === "WEEKLY") {
      var dow = RecurringService.normalizeDayOfWeek(rule.day_of_week);
      next = dow === null
        ? RecurringService.nextWeekdayAfter(from, RecurringService.utcWeekday(from))
        : RecurringService.nextWeekdayAfter(from, dow);
    } else {
      var dom = RecurringService.normalizeDayOfMonth(rule.day_of_month) || from.getUTCDate();
      if (freq === "MONTHLY") {
        next = RecurringService.clampDayOfMonth(
          new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)), dom);
      } else if (freq === "QUARTERLY") {
        next = RecurringService.clampDayOfMonth(
          new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 3, 1)), dom);
      } else if (freq === "YEARLY") {
        next = RecurringService.clampDayOfMonth(
          new Date(Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), 1)), dom);
      } else {
        throw new Error("Unknown frequency '" + freq + "'.");
      }
    }
    return dateStamp(next);
  },

  /**
   * Materializes every due occurrence of every active rule into the ledger.
   * Called by a daily trigger and by action "recurring.run". Iterates from the
   * last materialized run through today, so all missed occurrences are booked
   * exactly once — results are identical whether the trigger runs daily,
   * weekly or after a long gap. Each occurrence carries the idempotency key
   * REC-<id>-<date>, so re-running can never double-book.
   */
  run: function () {
    return withLock(function () {
      var today = todayStamp();
      var rules = readTable("recurring").filter(function (r) {
        return String(r.status).toUpperCase() === "ACTIVE" &&
               String(r.next_run) && String(r.next_run) <= today;
      });
      var created = 0;
      var now = isoNow();
      rules.forEach(function (rule) {
        try {
          var row = findRow("recurring", "recurring_id", rule.recurring_id);
          var cursor = String(rule.last_run)
            ? RecurringService.computeNextRun(rule, rule.type, String(rule.last_run))
            : String(rule.next_run);
          var lastRun = String(rule.last_run);
          var completed = false;
          var guard = 0;
          while (cursor <= today && guard < 10000) {
            guard++;
            if (rule.end_date && cursor > String(rule.end_date)) { completed = true; break; }
            var extRef = "REC-" + rule.recurring_id + "-" + cursor;
            var existing = DuplicateDetectionService.findByExternalRef(extRef);
            if (!existing) {
              var payload = {
                action: "transaction.create",
                type: rule.type,
                amount: Number(rule.amount),
                currency: rule.currency,
                date: cursor,
                account_id: rule.account_id,
                from_account_id: rule.from_account_id,
                to_account_id: rule.to_account_id,
                category_id: rule.category_id,
                income_source_id: rule.income_source_id,
                note: "Recurring: " + rule.name,
                source: "SYSTEM",
                external_ref: extRef
              };
              var result = ValidationService.validateTransaction(payload);
              if (!result.valid) break; // rule misconfigured; retried once fixed
              TransactionService.persist(TransactionService.normalize(payload, result));
              created++;
            }
            lastRun = cursor;
            cursor = RecurringService.computeNextRun(rule, rule.type, cursor);
          }
          if (rule.end_date && cursor > String(rule.end_date)) completed = true;
          if (row) {
            if (completed) {
              updateRow("recurring", row, {
                last_run: lastRun, next_run: "", status: "COMPLETED", updated_at: now
              });
            } else {
              updateRow("recurring", row, {
                last_run: lastRun, next_run: cursor, updated_at: now
              });
            }
          }
        } catch (err) {
          Logger.log("recurring rule failed: " + rule.recurring_id + " " + err.message);
        }
      });
      if (created > 0) emit("ledger.changed", { recurring: true });
      return { data: { materialized: created, scanned: rules.length } };
    });
  },

  apiRun: function () {
    return RecurringService.run();
  }
};
