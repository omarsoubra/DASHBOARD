#!/usr/bin/env python3
"""LOCKED IN Health shortcut (Apple Shortcuts plist) - Omar 2026-10-14.

Formats come from real shared Health shortcuts (Find Health Samples filter templates, Get Details, Get Contents of URL)
and were checked in the iPhone editor: 'Start Date is today' (operator 1002), 'Group by Day', 'Latest First', limit 1.
v2/v3: one POST per reading (steps, then active energy, then resting heart rate); v3 sends every reading + its source. A reading Apple Health does not have
stops the shortcut at that step, so everything sent before it has already arrived. Active Energy carries its unit (kcal).

usage: build_shortcut.py <out.shortcut> [--key-file F --name N]   (--key-file: a private test copy with the code built in)
then:  shortcuts sign --mode anyone --input <out> --output <signed>
"""
import plistlib, uuid, sys
U = lambda: str(uuid.uuid4()).upper()
API = "https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api"
args = sys.argv[1:]
out_path = args[0]
key = open(args[args.index("--key-file") + 1]).read().strip() if "--key-file" in args else ""
name = args[args.index("--name") + 1] if "--name" in args else "LOCKED IN Health"
acts = []
def outp(uid, nm): return {"Value": {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": nm}, "WFSerializationType": "WFTextTokenAttachment"}
def var_tok(v): return {"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {"VariableName": v, "Type": "Variable"}}}, "WFSerializationType": "WFTextTokenString"}
def txt(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
item = lambda k, v: {"WFKey": txt(k), "WFItemType": 0, "WFValue": v}

t0 = U(); acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.gettext", "WFWorkflowActionParameters": {"WFTextActionText": key, "UUID": t0}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": outp(t0, "Text"), "WFVariableName": "Code"}})
d = U(); fd = U()
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.date", "WFWorkflowActionParameters": {"UUID": d}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.format.date", "WFWorkflowActionParameters": {"WFDate": {"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {
    "Type": "ActionOutput", "OutputName": "Date", "OutputUUID": d, "Aggrandizements": [{"WFDateFormatStyle": "ISO 8601", "WFISO8601IncludeTime": False, "Type": "WFDateFormatVariableAggrandizement"}]}}},
    "WFSerializationType": "WFTextTokenString"}, "UUID": fd}})
acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": outp(fd, "Formatted Date"), "WFVariableName": "Day"}})

def find(hktype, single, unit=None):
    """Find Health Samples of today. single: the latest one sample (resting heart rate); else every reading of today."""
    f = U()
    p = {"WFContentItemFilter": {"Value": {"WFActionParameterFilterPrefix": 1, "WFActionParameterFilterTemplates": [
            {"Property": "Type", "Operator": 4, "Values": {"Enumeration": {"Value": hktype, "WFSerializationType": "WFStringSubstitutableState"}}, "Removable": False, "Bounded": True},
            {"Property": "Start Date", "Operator": 1002, "Values": {"Unit": {"Value": 16, "WFSerializationType": "WFCalendarUnitSubstitutableState"},
                                                                     "Number": {"Value": "1", "WFSerializationType": "WFNumberStringSubstitutableState"}}, "Removable": False, "Bounded": True}],
            "WFContentPredicateBoundedDate": False}, "WFSerializationType": "WFContentPredicateTableTemplate"},
         "WFContentItemSortProperty": "Start Date", "WFContentItemSortOrder": "Latest First",
         "WFContentItemLimitEnabled": bool(single), "WFHKSampleFilteringFillMissing": False, "UUID": f}
    if single:
        p["WFContentItemLimitNumber"] = 1.0
    if unit:
        p["WFHKSampleFilteringUnit"] = unit
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.filter.health.quantity", "WFWorkflowActionParameters": p})
    return f

def detail(src_uuid, prop, var):
    v = U()
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.properties.health.quantity",
                 "WFWorkflowActionParameters": {"WFInput": outp(src_uuid, "Health Samples"), "WFContentItemPropertyName": prop, "UUID": v}})
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable", "WFWorkflowActionParameters": {"WFInput": outp(v, prop), "WFVariableName": var}})

def post(fields):
    acts.append({"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl", "WFWorkflowActionParameters": {
        "UUID": U(), "WFURL": API, "WFHTTPMethod": "POST", "WFHTTPBodyType": "JSON", "ShowHeaders": True,
        "WFHTTPHeaders": {"Value": {"WFDictionaryFieldValueItems": [item("content-type", txt("application/json"))]}, "WFSerializationType": "WFDictionaryFieldValue"},
        "WFJSONValues": {"Value": {"WFDictionaryFieldValueItems": [item("type", txt("healthLog")), item("healthKey", var_tok("Code")),
                                                                    item("date", var_tok("Day"))] + [item(k, var_tok(v)) for k, v in fields]},
                         "WFSerializationType": "WFDictionaryFieldValue"}}})

# v3: steps and active energy send EVERY reading of today with its source; the server sums per source (Apple Health
# de-duplicates iPhone + Watch the same way). Resting heart rate: the latest reading. One POST each, steps first.
f = find("Steps", False); detail(f, "Value", "StepsList"); detail(f, "Source", "StepsSources")
post([("stepsList", "StepsList"), ("stepsSources", "StepsSources")])
f = find("Active Energy", False, "kcal"); detail(f, "Value", "ActiveList"); detail(f, "Source", "ActiveSources")
post([("activeList", "ActiveList"), ("activeSources", "ActiveSources")])
f = find("Resting Heart Rate", True); detail(f, "Value", "RestingHR")
post([("restingHr", "RestingHR")])

wf = {"WFWorkflowMinimumClientVersionString": "900", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowClientVersion": "3218.0.9",
      "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59754},
      "WFWorkflowActions": acts, "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [],
      "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False, "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
      "WFWorkflowImportQuestions": [] if key else [{"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
                                                   "Text": "Paste your LOCKED IN code (copied from the setup page)", "DefaultValue": ""}]}
plistlib.dump(wf, open(out_path, "wb"), fmt=plistlib.FMT_BINARY)
print(f"{len(acts)} actions{' (test copy, code built in)' if key else ''} -> {name}")
