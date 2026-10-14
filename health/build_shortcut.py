#!/usr/bin/env python3
"""LOCKED IN Health shortcut (Apple Shortcuts plist) - Omar 2026-10-14.

Formats come from real shared Health shortcuts (Find Health Samples filter templates, Get Details, Get Contents of URL)
and were checked in the iPhone editor: 'Start Date is today' (operator 1002), 'Group by Day', 'Latest First', limit 1.
v2/v3: one POST per reading (steps, then active energy, then resting heart rate); v3 sends every reading + its source. A reading Apple Health does not have
stops the shortcut at that step, so everything sent before it has already arrived. Active Energy carries its unit (kcal).
v4 (2026-10-14, formats read back on Omar's iPhone): 'Start Date is in the last 3 days' (operator 1001, unit day), every reading with its
ISO start time, so yesterday is re-sent with its final total; sleep stages ("Sleep": In Bed / Core / Deep / REM / Awake with start + end);
exercise minutes ("Exercise Time", min); latest resting heart rate with its time. Three POSTs: steps + active, sleep, exercise + resting HR.
An empty type (e.g. no Exercise Minutes from a Garmin) sends empty lists and does not stop the shortcut.

usage: build_shortcut.py <out.shortcut> [--key-file F --name N --api URL]   (--key-file: a private test copy with the code built in; --api: test receiver)
then:  shortcuts sign --mode anyone --input <out> --output <signed>
"""
import plistlib, uuid, sys
U = lambda: str(uuid.uuid4()).upper()
API = "https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api"
args = sys.argv[1:]
out_path = args[0]
key = open(args[args.index("--key-file") + 1]).read().strip() if "--key-file" in args else ""
name = args[args.index("--name") + 1] if "--name" in args else "LOCKED IN Health"
if "--api" in args: API = args[args.index("--api") + 1]   # test only: capture on a local receiver
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

ISO = [{"WFDateFormatStyle": "ISO 8601", "WFISO8601IncludeTime": True, "Type": "WFDateFormatVariableAggrandizement"}]
def var_iso(v): return {"Value": {"string": "\ufffc", "attachmentsByRange": {"{0, 1}": {"VariableName": v, "Type": "Variable", "Aggrandizements": ISO}}}, "WFSerializationType": "WFTextTokenString"}
WINDOW_DAYS = "3"

def find(hktype, single, unit=None):
    """Find Health Samples of the last WINDOW_DAYS days (rolling). single: the latest one sample (resting heart rate)."""
    f = U()
    p = {"WFContentItemFilter": {"Value": {"WFActionParameterFilterPrefix": 1, "WFActionParameterFilterTemplates": [
            {"Property": "Type", "Operator": 4, "Values": {"Enumeration": {"Value": hktype, "WFSerializationType": "WFStringSubstitutableState"}}, "Removable": False, "Bounded": True},
            {"Property": "Start Date", "Operator": 1001, "Values": {"Unit": {"Value": 16, "WFSerializationType": "WFCalendarUnitSubstitutableState"},
                                                                     "Number": {"Value": WINDOW_DAYS, "WFSerializationType": "WFNumberStringSubstitutableState"}}, "Removable": False, "Bounded": True}],
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
                                                                    item("date", var_tok("Day"))] + [item(k, var_iso(v) if k.endswith(("Dates", "Starts", "Ends", "Date")) else var_tok(v)) for k, v in fields]},
                         "WFSerializationType": "WFDictionaryFieldValue"}}})

# v4: every reading of the last 3 days with its source and ISO start time; the server buckets each into its own Sydney
# day and sums per source (largest device wins = Apple Health's de-duplication of iPhone + Watch / Garmin).
f = find("Steps", False); detail(f, "Value", "StepsList"); detail(f, "Source", "StepsSources"); detail(f, "Start Date", "StepsDates")
# "Active Energy" in the editor is stored as "Active Calories" (read back from iOS 2026-10-14)
f = find("Active Calories", False, "kcal"); detail(f, "Value", "ActiveList"); detail(f, "Source", "ActiveSources"); detail(f, "Start Date", "ActiveDates")
post([("stepsList", "StepsList"), ("stepsSources", "StepsSources"), ("stepsDates", "StepsDates"),
      ("activeList", "ActiveList"), ("activeSources", "ActiveSources"), ("activeDates", "ActiveDates")])
# sleep stages (category samples: Value is the stage name; Source comes back empty, so the server merges overlaps instead)
f = find("Sleep", False); detail(f, "Value", "SleepValues"); detail(f, "Start Date", "SleepStarts"); detail(f, "End Date", "SleepEnds")
post([("sleepValues", "SleepValues"), ("sleepStarts", "SleepStarts"), ("sleepEnds", "SleepEnds")])
# "Exercise Minutes" in the editor is stored as "Exercise Time"
f = find("Exercise Time", False, "min"); detail(f, "Value", "ExerciseList"); detail(f, "Source", "ExerciseSources"); detail(f, "Start Date", "ExerciseDates")
f = find("Resting Heart Rate", True); detail(f, "Value", "RestingHR"); detail(f, "Start Date", "RestingHRDate")
post([("exerciseList", "ExerciseList"), ("exerciseSources", "ExerciseSources"), ("exerciseDates", "ExerciseDates"),
      ("restingHr", "RestingHR"), ("restingHrDate", "RestingHRDate")])

wf = {"WFWorkflowMinimumClientVersionString": "900", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowClientVersion": "3218.0.9",
      "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59754},
      "WFWorkflowActions": acts, "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [],
      "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False, "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
      "WFWorkflowImportQuestions": [] if key else [{"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
                                                   "Text": "Paste your LOCKED IN code (copied from the setup page)", "DefaultValue": ""}]}
plistlib.dump(wf, open(out_path, "wb"), fmt=plistlib.FMT_BINARY)
print(f"{len(acts)} actions{' (test copy, code built in)' if key else ''} -> {name}")
