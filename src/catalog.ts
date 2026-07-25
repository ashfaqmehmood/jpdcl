import type { EndpointDefinition } from "./types.js";

const main = (
  path: string,
  description: string,
  options: Partial<EndpointDefinition> = {},
): EndpointDefinition => ({
  portal: "main",
  method: "POST",
  path,
  encrypted: true,
  auth: "main-session",
  dataClass: "observed",
  description,
  ...options,
});

const smart = (
  method: EndpointDefinition["method"],
  path: string,
  description: string,
  options: Partial<EndpointDefinition> = {},
): EndpointDefinition => ({
  portal: "smart",
  method,
  path,
  auth: "smart-bearer",
  dataClass: "observed",
  description,
  ...options,
});

const ledger = (
  path: string,
  description: string,
  options: Partial<EndpointDefinition> = {},
): EndpointDefinition => ({
  portal: "ledger",
  method: "POST",
  path,
  encrypted: false,
  auth: "public",
  dataClass: "observed",
  description,
  ...options,
});

export const endpointCatalog = {
  // JPDCL WSS authentication and account management
  main_login: main("/userLoginWebNew", "Consumer login; credentials are supplied in a dedicated header", {
    method: "GET",
    auth: "public-basic",
    encrypted: false,
  }),
  main_department_login: main("/departmentLogin", "Corporate/department login", {
    auth: "public-basic",
    encrypted: false,
    bodyExample: { userid: "USER", password: "PASSWORD" },
  }),
  main_validate_password: main("/validatePassword", "Validate an existing password", {
    mutation: false,
  }),
  main_reset_password: main("/resetPasswordNew", "Reset an authenticated user's password", {
    mutation: true,
  }),
  main_forgot_password: main("/forgetPasswordNew", "Forgot-password OTP and reset workflow", {
    auth: "public-basic",
    mutation: true,
  }),
  main_register: main("/userRegistrationNew", "Consumer registration and OTP workflow", {
    auth: "public-basic",
    mutation: true,
  }),
  main_visitor_count: main("/visitorCount", "Read/update portal visitor count", {
    auth: "public-basic",
    bodyExample: { visitor_type: "web" },
  }),
  main_customer_info: main("/GetCustomerInfo", "Complete consumer, account, bill, and meter summary", {
    auth: "public-basic",
    bodyExample: { accountid: "0000000000" },
  }),
  main_accounts_for_identity: main("/getAccountsByEmailMobile", "Accounts registered to an email or mobile number"),
  main_add_primary_account: main("/addPrimaryAccount", "Attach a primary account to a login", {
    auth: "public-basic",
    mutation: true,
    bodyExample: { loginid: "...", accountid: "...", consumercode: "..." },
  }),
  main_linked_accounts: main("/getLinkedAccountsNew", "List linked consumer accounts", {
    bodyExample: { loginid: "..." },
  }),
  main_link_account: main("/linkAccountNew", "Link a child account", {
    mutation: true,
    bodyExample: {
      loginid: "...",
      parent_acc_id: "...",
      child_acc_id: "...",
      child_consumer_code: "...",
    },
  }),
  main_swap_linked_account: main("/swapLinkedAccount", "Make a linked account primary", {
    mutation: true,
  }),
  main_delink_account: main("/delinkAccountNew", "Remove a linked account", { mutation: true }),
  main_update_contact: main("/updateContectDetails", "Update mobile number or email", {
    mutation: true,
  }),
  main_alert_settings: main("/alertSettings", "Read or update alert settings", { mutation: true }),

  // Bills, payments, consumption, and meters
  main_bill_history: main("/BillPaymentHist", "Bill or payment history for a date range", {
    bodyExample: { acct_id: "...", type: "BILL", st_dt: "2026-01-01", en_dt: "2026-07-31" },
  }),
  main_bill_pdf: main("/BillPDF", "Download an electricity bill as encoded PDF data", {
    binary: true,
    bodyExample: { bill_id: "..." },
  }),
  main_consumption: main("/GetBillConsumption", "Meter/register consumption history", {
    bodyExample: { accountid: "...", fromdate: "2026-01-01", todate: "2026-07-31" },
  }),
  main_consumption_legacy: main("/ConsumptionHist", "Legacy consumption history endpoint"),
  main_meter_changes: main("/GetMeterChangedHistory", "Meter replacement/change history"),
  main_meter_status: main("/meterStatus", "Live prepaid meter connection status", {
    bodyExample: { account_id: "..." },
  }),
  main_prepaid_transactions: main("/prepaidChargePayment", "Prepaid charges, payments, and recharges", {
    bodyExample: {
      account_id: "...",
      transaction_type: "CHARGE",
      fromdate: "01-07-2026",
      todate: "24-07-2026",
    },
  }),
  main_prepaid_bill_history: main("/getPrepaidBillHistory", "Prepaid billing-segment history"),
  main_prepaid_bill_distribution: main("/getBillDistribution", "Detailed prepaid bill breakup", {
    bodyExample: { bseg_id: "..." },
  }),
  main_prepaid_statement_date: main("/PrepaidStatementPDFByDate", "Prepaid PDF statement by date range", {
    binary: true,
  }),
  main_prepaid_statement_month: main("/PrepaidStatementPDFByMonth", "Prepaid PDF statement by month", {
    binary: true,
  }),
  main_same_day_transaction: main("/CheckSameDayTransaction", "Check for an existing same-day payment", {
    auth: "public-basic",
  }),
  main_initiate_payment: main("/InitiateBillPayRequest", "Create a BillDesk payment intent", {
    auth: "public-basic",
    mutation: true,
  }),
  main_cancel_payment_remark: main("/updateRemarkOnPaymentCancel", "Record a cancelled payment attempt", {
    auth: "public-basic",
    mutation: true,
  }),
  main_amnesty_info: main("/getAMNESTYConsumerInfo", "Amnesty-scheme consumer information", {
    auth: "public-basic",
  }),

  // Complaints, contact, corporate/group billing, and diagnostics
  main_complaint_types: main("/getListOfComplaint", "Available technical and non-technical complaint types"),
  main_complaints: main("/complaintStatus", "Complaint/service-request history and status"),
  main_register_complaint: main("/registerComplaint", "Register a complaint or service request", {
    mutation: true,
  }),
  main_contact: main("/contactus", "Submit a contact-us message", {
    auth: "public-basic",
    mutation: true,
  }),
  main_group_info: main("/getGroupConsumerInfo", "Department/corporate consumer group information"),
  main_group_hierarchy: main("/getHierarchy", "Department/corporate circle/division/subdivision hierarchy"),
  main_group_payment: main("/InitiateGroupPayRequest", "Create a corporate group payment intent", {
    mutation: true,
  }),
  main_group_payment_report: main("/GroupPaymentReport", "Corporate group payment report"),
  main_smart_sso: main("/getGenusSSOToken", "Issue the Genus smart-meter portal SSO JWT", {
    auth: "public-basic",
    bodyExample: { accountId: "...", mtrno: "..." },
  }),
  main_generate_log: main("/generateLog", "Portal client diagnostic logging", {
    auth: "public-basic",
    mutation: true,
  }),
  // Current Genus consumer portal (cp.rdssjpdcl.com). Exchange the JPDCL
  // login-bypass JWT through switch-account before making consumer data calls.
  smart_otp_send: smart("POST", "/Authentication/otp-login/send", "Send consumer-login OTP", { auth: "public", mutation: true }),
  smart_otp_verify: smart("POST", "/Authentication/otp-login/verify", "Verify consumer-login OTP", { auth: "public", mutation: true }),
  smart_guest_otp_send: smart("POST", "/Authentication/guest-login/send-otp", "Send guest-login OTP", { auth: "public", mutation: true }),
  smart_guest_otp_verify: smart("POST", "/Authentication/guest-login/verify-otp", "Verify guest-login OTP", { auth: "public", mutation: true }),
  smart_switch_account: smart("POST", "/Authentication/switch-account", "Switch the current smart-meter account and issue a refreshed token", { dataClass: "configuration" }),
  smart_logout: smart("POST", "/Authentication/logout", "Invalidate a smart-meter session", { mutation: true }),
  smart_admin_login: smart("POST", "/AdminAuth/login", "Authenticate to the separately protected smart-portal administration area", { auth: "public" }),
  smart_admin_login_counts: smart("GET", "/LoginHistory/login-counts", "Administrative consumer login-count report", { auth: "smart-admin" }),
  smart_admin_bypass_link: smart("POST", "/consumerportal/api/ConsumerPortal/CreateToken", "Generate a consumer bypass URL from the administration API", { auth: "smart-admin", mutation: true, bodyExample: { region: "JPDCL", kno: "...", meterNumber: "..." } }),

  // Consumption, readings, forecasts, balance, and alerts
  smart_today_monthly: smart("GET", "/EnergyConsumption/todayormonthlyconsumption/{meterNumber}", "Today's and current-month consumption", { parameters: ["meterNumber"] }),
  smart_current_month: smart("GET", "/EnergyConsumption/current-month/{accountId}", "Current-month energy consumption", { parameters: ["accountId"] }),
  smart_last_month_bill: smart("GET", "/energyconsumption/last-month-bill/{accountId}", "Last-month bill through the energy service", { parameters: ["accountId"] }),
  smart_meter_reading: smart("GET", "/energyconsumption/meter-reading/{meterNumber}", "Meter reading history and on-demand status", { parameters: ["meterNumber"] }),
  smart_current_meter_reading: smart("GET", "/EnergyConsumption/current-meter-reading/{accountId}", "Latest smart-meter reading", { parameters: ["accountId"] }),
  smart_prepaid_recharge_balance: smart("GET", "/energyconsumption/prepaid-recharge-balance/{accountId}", "Prepaid recharge and balance summary", { parameters: ["accountId"] }),
  smart_prepaid_balance: smart("GET", "/EnergyConsumption/prepaid-balance-status/{meterNumber}", "Current prepaid balance and status", { parameters: ["meterNumber"] }),
  smart_bill_summary: smart("GET", "/energyconsumption/bill-summary/{accountId}?fromDate={fromDate}&toDate={toDate}", "Bill summary for a date range", { parameters: ["accountId", "fromDate", "toDate"] }),
  smart_insights: smart("GET", "/energyconsumption/insights/{accountId}", "Derived energy insights, comparisons, savings estimates, and smart tips; not raw meter evidence", { parameters: ["accountId"], dataClass: "derived" }),
  smart_forecast_today: smart("GET", "/EnergyConsumption/forecast/today/{meterNumber}", "Predicted consumption for today; not a measured reading", { parameters: ["meterNumber"], dataClass: "derived" }),
  smart_forecast_weekly: smart("GET", "/EnergyConsumption/forecast/weekly/{meterNumber}", "Predicted weekly consumption; not measured readings", { parameters: ["meterNumber"], dataClass: "derived" }),
  smart_forecast_monthly: smart("GET", "/EnergyConsumption/forecast/monthly/{meterNumber}", "Predicted monthly consumption; not measured readings", { parameters: ["meterNumber"], dataClass: "derived" }),
  smart_consumption_comparison: smart("GET", "/EnergyConsumption/consumption/{meterNumber}?type={type}&value={value}", "Daily, weekly, or monthly consumption comparison", { parameters: ["meterNumber", "type", "value"] }),
  smart_consumption_30min: smart("GET", "/EnergyConsumption/30min-log/{meterNumber}?fromDate={fromDate}&toDate={toDate}&sortOrder={sortOrder}", "Half-hour interval import/export log", { parameters: ["meterNumber", "fromDate", "toDate", "sortOrder"] }),
  smart_consumption_30min_csv: smart("GET", "/EnergyConsumption/30min-log/{meterNumber}/download/csv?fromDate={fromDate}&toDate={toDate}&sortOrder={sortOrder}", "Download half-hour interval log as CSV", { parameters: ["meterNumber", "fromDate", "toDate", "sortOrder"], binary: true }),
  smart_consumption_30min_pdf: smart("GET", "/EnergyConsumption/30min-log/{meterNumber}/download/pdf?fromDate={fromDate}&toDate={toDate}&sortOrder={sortOrder}", "Download half-hour interval log as PDF", { parameters: ["meterNumber", "fromDate", "toDate", "sortOrder"], binary: true }),
  smart_on_demand_request: smart("POST", "/EnergyConsumption/OnDemandRequest", "Request an immediate meter read", { mutation: true, bodyExample: { meterNumber: "..." } }),
  smart_on_demand_logs: smart("GET", "/EnergyConsumption/instant-request-logs/{meterNumber}", "On-demand meter-read request history", { parameters: ["meterNumber"] }),
  smart_my_alerts: smart("GET", "/preferences/my-alerts?kno={accountId}&meterNo={meterNumber}", "Live, daily, and monthly consumption alert snapshot", { parameters: ["accountId", "meterNumber"] }),

  // Postpaid and prepaid histories
  smart_postpaid_payment_history: smart("GET", "/postpaidbilling/payment-history/{accountId}", "Postpaid payment history", { parameters: ["accountId"] }),
  smart_postpaid_bill_history: smart("GET", "/postpaidbilling/bill-history/{accountId}", "Postpaid bill history", { parameters: ["accountId"] }),
  smart_postpaid_last_bill: smart("GET", "/postpaidbilling/last-month-bill/{accountId}", "Latest postpaid bill", { parameters: ["accountId"] }),
  smart_prepaid_recharge_history: smart("GET", "/billing/{meterNumber}/RechargeHistory", "Prepaid recharge history with optional duration/status filters", { parameters: ["meterNumber"] }),
  smart_prepaid_bill_history: smart("GET", "/billing/{meterNumber}/billingHistory", "Prepaid billing summary with optional duration/status filters", { parameters: ["meterNumber"] }),
  smart_prepaid_recharge_pdf: smart("GET", "/EnergyConsumption/recharge-history/{accountId}/download/pdf?month={month}&year={year}", "Download monthly prepaid recharge history PDF", { parameters: ["accountId", "month", "year"], binary: true }),

  // Complaints and guided support
  smart_faqs: smart("GET", "/ConsumerProfile/faqs", "Frequently asked questions", { dataClass: "advisory" }),
  smart_contact_support: smart("GET", "/ConsumerProfile/contact-support", "Support telephone and email", { dataClass: "configuration" }),
  smart_complaint_categories: smart("GET", "/complaint-categories", "Complaint categories"),
  smart_complaint_priorities: smart("GET", "/complaint-categories/priorities", "Complaint priority values"),
  smart_complaints: smart("GET", "/Complaints/my-complaints", "Paginated complaints; accepts userId, statusCodes, pageNumber, and pageSize"),
  smart_create_complaint: smart("POST", "/Complaints", "Create a complaint", { mutation: true }),
  smart_cancel_complaint: smart("POST", "/Complaints/{complaintId}/cancel", "Cancel a complaint with a reason", { parameters: ["complaintId"], mutation: true }),
  smart_track_complaint: smart("GET", "/Complaints/{complaintId}/track", "Complaint timeline and current status", { parameters: ["complaintId"] }),
  smart_chatbot_questions: smart("GET", "/chatbot/questions", "Guided support chatbot questions"),
  smart_chatbot_submit: smart("POST", "/chatbot/submit", "Submit guided-support answers", { mutation: true, bodyExample: { userId: "...", answers: [] } }),
  smart_msedcl_chatbot_questions: smart("GET", "/msedclchatbot/questions", "Alternate DISCOM chatbot questions"),
  smart_msedcl_chatbot_options: smart("GET", "/msedclchatbot/options?typeId={typeId}&majorTypeId={majorTypeId}", "Alternate chatbot dependent options", { parameters: ["typeId", "majorTypeId"] }),
  smart_msedcl_chatbot_precheck: smart("POST", "/msedclchatbot/precheck", "Alternate chatbot request precheck"),
  smart_msedcl_chatbot_submit: smart("POST", "/msedclchatbot/submit", "Submit alternate chatbot request", { mutation: true }),
  smart_msedcl_chatbot_tickets: smart("GET", "/msedclchatbot/tickets", "Alternate chatbot tickets"),
  smart_msedcl_chatbot_ticket: smart("GET", "/msedclchatbot/tickets/{ticketId}", "Alternate chatbot ticket detail", { parameters: ["ticketId"] }),

  // Profile, preferences, notifications, localization, and offices
  smart_meter_details: smart("GET", "/ConsumerProfile/meter-details/{meterNumber}", "Meter installation and technical details", { parameters: ["meterNumber"] }),
  smart_tariff_details: smart("GET", "/ConsumerProfile/tariff-details", "Current tariff details"),
  smart_slab_rates: smart("GET", "/ConsumerProfile/slab-rates", "Tariff slab rates"),
  smart_page_content: smart("GET", "/ConsumerProfile/page-content/{contentKey}?tenantId={tenantId}", "Tenant-managed explanatory, legal, or energy-saving content; not meter evidence", { parameters: ["contentKey", "tenantId"], dataClass: "advisory" }),
  smart_update_account_label: smart("PUT", "/ConsumerProfile/me/account-label", "Update account label/type", { mutation: true }),
  smart_update_language: smart("POST", "/Localization/user/language", "Update preferred language", { mutation: true }),
  smart_preferences: smart("GET", "/preferences?isPrepaid={isPrepaid}", "Notification preferences", { parameters: ["isPrepaid"] }),
  smart_update_preferences: smart("PUT", "/preferences", "Update one notification preference", { mutation: true, bodyExample: { key: "...", value: "true" } }),
  smart_enable_all_preferences: smart("POST", "/preferences/enable-all", "Enable all notifications", { mutation: true }),
  smart_disable_all_preferences: smart("POST", "/preferences/disable-all", "Disable all notifications", { mutation: true }),
  smart_update_alerts: smart("POST", "/preferences/my-alerts", "Update daily and monthly consumption alert thresholds", { mutation: true, bodyExample: { Kno: "...", MeterNo: "...", Daily: { IsEnabled: true, RateKwh: 10, Description: null }, Monthly: { IsEnabled: true, RateKwh: 250, Description: null } } }),
  smart_notifications: smart("GET", "/Notifications/{userId}", "All notifications for a user", { parameters: ["userId"] }),
  smart_notification_unread_count: smart("GET", "/Notifications/unread-count/{userId}", "Unread notification count", { parameters: ["userId"] }),
  smart_notification_mark_read: smart("POST", "/Notifications/read/{notificationId}?userId={userId}", "Mark one notification read", { parameters: ["notificationId", "userId"], mutation: true }),
  smart_notification_mark_all_read: smart("POST", "/Notifications/read-all/{userId}", "Mark every notification read", { parameters: ["userId"], mutation: true }),
  smart_notification_delete: smart("DELETE", "/Notifications/{notificationId}", "Delete a notification", { parameters: ["notificationId"], mutation: true }),
  smart_notification_filter: smart("GET", "/Notifications/{userId}/filter", "Filter notifications by type, unread state, duration, or dates", { parameters: ["userId"] }),
  smart_nearby_offices: smart("GET", "/ConsumerProfile/nearby-offices?lat={lat}&lng={lng}", "Locate nearby offices; optional query can be supplied", { parameters: ["lat", "lng"] }),
  smart_appliances: smart("GET", "/Appliance", "Reference appliance catalog and default wattages used for local estimates", { dataClass: "configuration" }),

  // Analytical reports. filter is the portal's query-string filter; format may be csv/pdf.
  smart_report: smart("GET", "/Report/{meterNumber}/{reportType}", "Power events, TOD, peak-slot, voltage, and maximum-demand reports", { parameters: ["meterNumber", "reportType"] }),
  smart_report_power_events: smart("GET", "/Report/{meterNumber}/PowerOnOff", "Power on/off event report", { parameters: ["meterNumber"] }),
  smart_report_daily_tod: smart("GET", "/Report/{meterNumber}/DayWiseTOD", "Daily time-of-day report", { parameters: ["meterNumber"] }),
  smart_report_monthly_tod: smart("GET", "/Report/{meterNumber}/MonthlyTOD", "Monthly time-of-day report", { parameters: ["meterNumber"] }),
  smart_report_peak_slots: smart("GET", "/Report/{meterNumber}/PeakSlotConsumption", "Current peak-slot consumption", { parameters: ["meterNumber"] }),
  smart_report_peak_slots_monthly: smart("GET", "/Report/{meterNumber}/PeakSlotConsumptionMonthly", "Monthly peak-slot consumption", { parameters: ["meterNumber"] }),
  smart_report_voltage: smart("GET", "/Report/{meterNumber}/ConsumerVoltageDataProfile", "Voltage profile report", { parameters: ["meterNumber"] }),
  smart_report_demand: smart("GET", "/Report/{meterNumber}/SanctionLoadVSMaxDemand", "Sanctioned load versus maximum demand", { parameters: ["meterNumber"] }),

  // Payment bridge exposed by this portal variant.
  smart_payment_initiate: smart("POST", "/msedcl-payment/initiate", "Create a payment intent", { mutation: true }),
  smart_payment_verify: smart("GET", "/msedcl-payment/verify?request_id={requestId}&statusCode={statusCode}&checksum={checksum}", "Verify a payment callback", { parameters: ["requestId", "statusCode", "checksum"] }),

  // Public daily smart-meter register ledger (smartmeter1.jpdcl.co.in).
  ledger_consumer_readings: ledger("/smartmeter/assets/php/_getConsumerDetails.php", "Daily cumulative import, export and net-import kWh/kVAh registers plus net-meter identity", { parameters: ["consumerId"] }),
  ledger_meter_alarms: ledger("/smartmeter/assets/php/_getAlarmDetails.php", "Meter alarm records exposed by the daily ledger service", { parameters: ["meterNumber"] }),
} satisfies Record<string, EndpointDefinition>;

export type EndpointName = keyof typeof endpointCatalog;

export function isEndpointName(name: string): name is EndpointName {
  return Object.prototype.hasOwnProperty.call(endpointCatalog, name);
}

export function listEndpoints(portal?: EndpointDefinition["portal"]) {
  return Object.entries(endpointCatalog)
    .filter(([, definition]) => !portal || definition.portal === portal)
    .map(([name, definition]) => ({ name, ...definition }));
}
