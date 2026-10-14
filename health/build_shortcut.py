"""Build the LOCKED IN Health shortcut (plist) from formats taken from two real shared Health shortcuts."""
import plistlib, uuid, sys
U = lambda: str(uuid.uuid4()).upper()
API = "https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api"
acts = []
def out(uid, name): return {"Value": {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name}, "WFSerializationType": "WFTextTokenAttachment"}
def var_tok(name): return {"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {"VariableName": name, "Type": "Variable"}}}, "WFSerializationType": "WFTextTokenString"}
def txt(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
# 0-1: the client's code (import question fills it in when the shortcut is added)
t0 = U(); acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.gettext", "WFWorkflowActionParameters": {"WFTextActionText": "", "UUID": t0}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": out(t0, "Text"), "WFVariableName": "Code"}})
def find(hktype, days, group_by_day):
    f = U()
    p = {"WFContentItemFilter": {"Value": {"WFActionParameterFilterPrefix": 1, "WFActionParameterFilterTemplates": [
            {"Property": "Type", "Operator": 4, "Values": {"Enumeration": {"Value": hktype, "WFSerializationType": "WFStringSubstitutableState"}}, "Removable": False, "Bounded": True},
            {"Property": "Start Date", "Operator": 1002, "Values": {"Unit": {"Value": 16, "WFSerializationType": "WFCalendarUnitSubstitutableState"},
                                                                     "Number": {"Value": str(days), "WFSerializationType": "WFNumberStringSubstitutableState"}}, "Removable": False, "Bounded": True}],
            "WFContentPredicateBoundedDate": False}, "WFSerializationType": "WFContentPredicateTableTemplate"},
         "WFContentItemSortProperty": "Start Date", "WFContentItemSortOrder": "Latest First",
         "WFContentItemLimitEnabled": True, "WFContentItemLimitNumber": 1.0, "WFHKSampleFilteringFillMissing": False, "UUID": f}
    if group_by_day:
        p["WFHKSampleFilteringGroupBy"] = "Day"
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.filter.health.quantity", "WFWorkflowActionParameters": p})
    v = U()
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.properties.health.quantity",
                 "WFWorkflowActionParameters": {"WFInput": out(f, "Health Samples"), "WFContentItemPropertyName": "Value", "UUID": v}})
    return v
for hk, name, grp in (("Steps", "Steps", True), ("Active Energy", "ActiveKcal", True), ("Resting Heart Rate", "RestingHR", False)):
    v = find(hk, 1, grp)
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": out(v, "Value"), "WFVariableName": name}})
# today's date, yyyy-mm-dd (same pair of actions as the source shortcut)
d = U(); fd = U()
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.date", "WFWorkflowActionParameters": {"UUID": d}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.format.date", "WFWorkflowActionParameters": {"WFDate": {"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {
    "Type": "ActionOutput", "OutputName": "Date", "OutputUUID": d, "Aggrandizements": [{"WFDateFormatStyle": "ISO 8601", "WFISO8601IncludeTime": False, "Type": "WFDateFormatVariableAggrandizement"}]}}},
    "WFSerializationType": "WFTextTokenString"}, "UUID": fd}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": out(fd, "Formatted Date"), "WFVariableName": "Day"}})
item = lambda k, v: {"WFKey": txt(k), "WFItemType": 0, "WFValue": v}
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl", "WFWorkflowActionParameters": {
    "UUID": U(), "WFURL": API, "WFHTTPMethod": "POST", "WFHTTPBodyType": "JSON", "ShowHeaders": True,
    "WFHTTPHeaders": {"Value": {"WFDictionaryFieldValueItems": [item("content-type", txt("application/json"))]}, "WFSerializationType": "WFDictionaryFieldValue"},
    "WFJSONValues": {"Value": {"WFDictionaryFieldValueItems": [
        item("type", txt("healthLog")), item("healthKey", var_tok("Code")), item("date", var_tok("Day")),
        item("steps", var_tok("Steps")), item("activeKcal", var_tok("ActiveKcal")), item("restingHr", var_tok("RestingHR"))]},
        "WFSerializationType": "WFDictionaryFieldValue"}}})
wf = {"WFWorkflowMinimumClientVersionString": "900", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowClientVersion": "3218.0.9",
      "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59754},
      "WFWorkflowActions": acts, "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [],
      "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False, "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
      "WFWorkflowImportQuestions": [{"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText", "Text": "Paste your LOCKED IN code (copied from the setup page)", "DefaultValue": ""}]}
plistlib.dump(wf, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)
print(len(acts), "actions")
