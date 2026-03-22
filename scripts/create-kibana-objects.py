#!/usr/bin/env python3
"""Create all Kibana saved objects for elastic-llm-benchmarker and export to NDJSON."""

import json
import os
import subprocess
import sys
import time

KIBANA_URL = os.environ.get("KIBANA_URL", "http://localhost:5601")
KIBANA_USER = os.environ.get("KIBANA_USER", "elastic")
KIBANA_PASS = os.environ.get("KIBANA_PASS", "changeme")

def api(method, path, body=None):
    cmd = [
        "curl", "-sf", "-X", method,
        f"{KIBANA_URL}{path}",
        "-H", "kbn-xsrf: true",
        "-H", "Content-Type: application/json",
        "-u", f"{KIBANA_USER}:{KIBANA_PASS}",
    ]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  FAILED: {method} {path}", file=sys.stderr)
        print(f"  stderr: {result.stderr}", file=sys.stderr)
        print(f"  stdout: {result.stdout}", file=sys.stderr)
        return None
    return json.loads(result.stdout) if result.stdout.strip() else None


def delete(obj_type, obj_id):
    subprocess.run([
        "curl", "-sf", "-X", "DELETE",
        f"{KIBANA_URL}/api/saved_objects/{obj_type}/{obj_id}?force=true",
        "-H", "kbn-xsrf: true",
        "-u", f"{KIBANA_USER}:{KIBANA_PASS}",
    ], capture_output=True)
    time.sleep(0.2)


def create(obj_type, obj_id, body, skip_delete=False):
    if not skip_delete:
        delete(obj_type, obj_id)
    result = api("POST", f"/api/saved_objects/{obj_type}/{obj_id}", body)
    if result:
        print(f"  Created {obj_type}/{obj_id}")
    return result


# --- Data Views ---
print("Creating data views...")
data_views = [
    ("benchmarker-results", "benchmarker-results", "@timestamp"),
    ("benchmarker-eval-reports", "benchmarker-eval-reports", "@timestamp"),
    ("benchmarker-queue", "benchmarker-queue", "requested_at"),
    ("benchmarker-checkpoints", "benchmarker-checkpoints", "@timestamp"),
    ("benchmarker-models", "benchmarker-models", "discovered_at"),
    ("benchmarker-errors", "benchmarker-errors", "@timestamp"),
    ("logs-docker-container", "logs-docker.container_log-*", "@timestamp"),
    ("metrics-system", "metrics-system.*", "@timestamp"),
    ("metrics-system-cpu", "metrics-system.cpu-*", "@timestamp"),
    ("metrics-system-memory", "metrics-system.memory-*", "@timestamp"),
    ("metrics-system-load", "metrics-system.load-*", "@timestamp"),
    ("metrics-system-process", "metrics-system.process-*", "@timestamp"),
    ("metrics-docker-cpu", "metrics-docker.cpu-*", "@timestamp"),
    ("metrics-docker-memory", "metrics-docker.memory-*", "@timestamp"),
]
for dv_id, title, time_field in data_views:
    delete("index-pattern", dv_id)
    result = api("POST", "/api/data_views/data_view", {
        "data_view": {"id": dv_id, "title": title, "timeFieldName": time_field},
        "override": True,
    })
    if result:
        print(f"  Created index-pattern/{dv_id}")

# --- Saved Searches ---
print("Creating saved searches...")
searches = [
    {
        "id": "search-queue-view",
        "title": "Queue View",
        "columns": ["model_id", "status", "priority", "requested_at", "started_at", "completed_at", "requested_by"],
        "sort": [["priority", "desc"]],
        "query": "",
        "index_ref": "benchmarker-queue",
    },
    {
        "id": "search-container-logs",
        "title": "Container Logs",
        "columns": ["@timestamp", "message", "container.name", "log.level"],
        "sort": [["@timestamp", "desc"]],
        "query": "message:(*OOM* or *oom* or *CUDA* or *cuda* or *Out of memory*)",
        "index_ref": "logs-docker-container",
    },
    {
        "id": "search-model-catalog",
        "title": "Model Catalog",
        "columns": ["model_id", "name", "architecture", "parameter_count_billions", "context_window", "license", "supports_tool_calling", "source"],
        "sort": [["model_id", "asc"]],
        "query": "",
        "index_ref": "benchmarker-models",
    },
    {
        "id": "search-error-events",
        "title": "Error Events",
        "columns": ["@timestamp", "model_id", "error_category", "error_message", "recovery_action", "attempt_number", "success", "node_name"],
        "sort": [["@timestamp", "desc"]],
        "query": "",
        "index_ref": "benchmarker-errors",
    },
]
for s in searches:
    search_source = json.dumps({
        "query": {"language": "kuery", "query": s["query"]},
        "filter": [],
        "indexRefName": "index_0",
    })
    create("search", s["id"], {
        "attributes": {
            "title": s["title"],
        "tabs": [{
            "id": "default",
            "label": s["title"],
            "attributes": {
                "kibanaSavedObjectMeta": {"searchSourceJSON": search_source},
                "columns": s["columns"],
                "sort": s["sort"],
            },
        }],
        },
        "references": [{"name": "index_0", "type": "index-pattern", "id": s["index_ref"]}],
    })

# --- Lens Visualizations ---
print("Creating Lens visualizations...")

def make_xy(title, vis_id, series_type, layers, ds_layers, index_ref):
    state = {
        "visualization": {
            "legend": {"isVisible": True, "position": "right"},
            "valueLabels": "show" if series_type == "bar" else "hide",
            "preferredSeriesType": "bar_stacked" if series_type == "bar" else "line",
            "layers": layers,
        },
        "query": {"query": "", "language": "kuery"},
        "filters": [],
        "datasourceStates": {"formBased": {"layers": ds_layers}},
    }
    return create("lens", vis_id, {
        "attributes": {"title": title, "visualizationType": "lnsXY", "state": state},
        "references": [{"type": "index-pattern", "id": index_ref, "name": "indexpattern-datasource-layer-layer1"}],
    })


# Results Table
create("lens", "vis-results-table", {
    "attributes": {
        "title": "Results Comparison Table",
        "visualizationType": "lnsDatatable",
        "state": {
            "visualization": {
                "layerId": "layer1", "layerType": "data",
                "columns": [{"columnId": f"col{i}"} for i in range(1, 8)],
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col1": {"label": "Model", "dataType": "string", "operationType": "terms", "sourceField": "model_id", "isBucketed": True, "params": {"size": 50, "orderBy": {"type": "column", "columnId": "col2"}, "orderDirection": "desc"}},
                    "col2": {"label": "Timestamp", "dataType": "date", "operationType": "last_value", "sourceField": "@timestamp", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "date"}}},
                    "col3": {"label": "Passed", "dataType": "boolean", "operationType": "last_value", "sourceField": "passed", "isBucketed": False, "params": {"sortField": "@timestamp"}},
                    "col4": {"label": "Success Rate", "dataType": "number", "operationType": "last_value", "sourceField": "tool_call_results.success_rate", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "percent"}}},
                    "col5": {"label": "Avg Latency (ms)", "dataType": "number", "operationType": "last_value", "sourceField": "tool_call_results.avg_tool_call_latency_ms", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "number"}}},
                    "col6": {"label": "Max Concurrent", "dataType": "number", "operationType": "last_value", "sourceField": "tool_call_results.max_concurrent_calls", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "number"}}},
                    "col7": {"label": "Total Tests", "dataType": "number", "operationType": "last_value", "sourceField": "tool_call_results.total_tests", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "number"}}},
                },
                "columnOrder": ["col1", "col2", "col3", "col4", "col5", "col6", "col7"],
                "incompleteColumns": {},
                "indexPatternId": "benchmarker-results",
            }}}},
        },
    },
    "references": [{"type": "index-pattern", "id": "benchmarker-results", "name": "indexpattern-datasource-layer-layer1"}],
})

# Bar charts
for vis_id, title, field, order_dir in [
    ("vis-throughput-bar", "Success Rate by Model", "tool_call_results.success_rate", "desc"),
    ("vis-itl-bar", "Avg Tool Call Latency (ms)", "tool_call_results.avg_tool_call_latency_ms", "asc"),
    ("vis-ttft-bar", "Max Concurrent Calls", "tool_call_results.max_concurrent_calls", "desc"),
]:
    label = title.replace(" Bar Chart", "")
    make_xy(title, vis_id, "bar",
        [{"layerId": "layer1", "seriesType": "bar", "xAccessor": "col-x", "accessors": ["col-y"], "layerType": "data"}],
        {"layer1": {
            "columns": {
                "col-x": {"label": "Model", "dataType": "string", "operationType": "terms", "sourceField": "model_id", "isBucketed": True, "params": {"size": 20, "orderBy": {"type": "column", "columnId": "col-y"}, "orderDirection": order_dir}},
                "col-y": {"label": f"Avg {label}", "dataType": "number", "operationType": "average", "sourceField": field, "isBucketed": False, "params": {"format": {"id": "number"}}},
            },
            "columnOrder": ["col-x", "col-y"],
            "incompleteColumns": {},
            "indexPatternId": "benchmarker-results",
        }},
        "benchmarker-results",
    )

# Tool Call Latency Trend
make_xy("Tool Call Latency Trend", "vis-throughput-trend", "line",
    [{"layerId": "layer1", "seriesType": "line", "xAccessor": "col-x", "accessors": ["col-y"], "splitAccessor": "col-z", "layerType": "data"}],
    {"layer1": {
        "columns": {
            "col-x": {"label": "Timestamp", "dataType": "date", "operationType": "date_histogram", "sourceField": "@timestamp", "isBucketed": True, "params": {"interval": "auto", "includeEmptyRows": True}},
            "col-y": {"label": "Avg Tool Call Latency (ms)", "dataType": "number", "operationType": "average", "sourceField": "tool_call_results.avg_tool_call_latency_ms", "isBucketed": False, "params": {"format": {"id": "number"}}},
            "col-z": {"label": "Model", "dataType": "string", "operationType": "terms", "sourceField": "model_id", "isBucketed": True, "params": {"size": 10, "orderBy": {"type": "alphabetical"}, "orderDirection": "asc"}},
        },
        "columnOrder": ["col-x", "col-z", "col-y"],
        "incompleteColumns": {},
        "indexPatternId": "benchmarker-results",
    }},
    "benchmarker-results",
)

# GPU Utilization by Model
make_xy("VRAM Utilization by Model (%)", "vis-gpu-vram-util", "bar",
    [{"layerId": "layer1", "seriesType": "bar", "xAccessor": "col-x", "accessors": ["col-y"], "layerType": "data"}],
    {"layer1": {
        "columns": {
            "col-x": {"label": "Model", "dataType": "string", "operationType": "terms", "sourceField": "model_id", "isBucketed": True, "params": {"size": 30, "orderBy": {"type": "column", "columnId": "col-y"}, "orderDirection": "desc"}},
            "col-y": {"label": "VRAM Utilization %", "dataType": "number", "operationType": "last_value", "sourceField": "gpu_utilization.vram_utilization_pct", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "number"}}},
        },
        "columnOrder": ["col-x", "col-y"],
        "incompleteColumns": {},
        "indexPatternId": "benchmarker-results",
    }},
    "benchmarker-results",
)

# Estimated vs Actual VRAM (side-by-side bar)
create("lens", "vis-gpu-estimated-vs-actual", {
    "attributes": {
        "title": "Estimated vs Actual VRAM (GB)",
        "visualizationType": "lnsXY",
        "state": {
            "visualization": {
                "legend": {"isVisible": True, "position": "right"},
                "valueLabels": "show",
                "preferredSeriesType": "bar",
                "layers": [{"layerId": "layer1", "seriesType": "bar", "xAccessor": "col-x", "accessors": ["col-actual"], "layerType": "data"}],
            },
            "query": {"query": "gpu_utilization.total_vram_used_gb: *", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-x": {"label": "Model", "dataType": "string", "operationType": "terms", "sourceField": "model_id", "isBucketed": True, "params": {"size": 30, "orderBy": {"type": "column", "columnId": "col-actual"}, "orderDirection": "desc"}},
                    "col-actual": {"label": "Actual VRAM (GB)", "dataType": "number", "operationType": "last_value", "sourceField": "gpu_utilization.total_vram_used_gb", "isBucketed": False, "params": {"sortField": "@timestamp", "format": {"id": "number"}}},
                },
                "columnOrder": ["col-x", "col-actual"],
                "incompleteColumns": {},
                "indexPatternId": "benchmarker-results",
            }}}},
        },
    },
    "references": [{"type": "index-pattern", "id": "benchmarker-results", "name": "indexpattern-datasource-layer-layer1"}],
})

# VRAM Used (GB) gauge - latest value
create("lens", "vis-gpu-vram-gauge", {
    "attributes": {
        "title": "Latest VRAM Used (GB)",
        "visualizationType": "lnsMetric",
        "state": {
            "visualization": {
                "layerId": "layer1", "layerType": "data",
                "metricAccessor": "col-val",
            },
            "query": {"query": "gpu_utilization.total_vram_used_gb: *", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-val": {
                        "label": "VRAM Used (GB)", "dataType": "number",
                        "operationType": "last_value", "sourceField": "gpu_utilization.total_vram_used_gb",
                        "isBucketed": False,
                        "params": {"sortField": "@timestamp", "format": {"id": "number"}},
                    },
                },
                "columnOrder": ["col-val"],
                "incompleteColumns": {},
                "indexPatternId": "benchmarker-results",
            }}}},
        },
    },
    "references": [{"type": "index-pattern", "id": "benchmarker-results", "name": "indexpattern-datasource-layer-layer1"}],
})

# Resource charts - use actual system metric data streams
for vis_id, title, field, fmt, index_ref in [
    ("vis-resource-cpu", "VM CPU Usage", "system.cpu.total.norm.pct", "percent", "metrics-system-cpu"),
    ("vis-resource-memory", "VM Memory Usage", "system.memory.used.pct", "percent", "metrics-system-memory"),
]:
    make_xy(title, vis_id, "line",
        [{"layerId": "layer1", "seriesType": "line", "xAccessor": "col-x", "accessors": ["col-y"], "layerType": "data"}],
        {"layer1": {
            "columns": {
                "col-x": {"label": "Timestamp", "dataType": "date", "operationType": "date_histogram", "sourceField": "@timestamp", "isBucketed": True, "params": {"interval": "auto", "includeEmptyRows": True}},
                "col-y": {"label": title, "dataType": "number", "operationType": "average", "sourceField": field, "isBucketed": False, "params": {"format": {"id": fmt}}},
            },
            "columnOrder": ["col-x", "col-y"],
            "incompleteColumns": {},
            "indexPatternId": index_ref,
        }},
        index_ref,
    )

# System Load (1m, 5m, 15m)
create("lens", "vis-resource-load", {
    "attributes": {
        "title": "VM System Load",
        "visualizationType": "lnsXY",
        "state": {
            "visualization": {
                "legend": {"isVisible": True, "position": "right"},
                "valueLabels": "hide",
                "preferredSeriesType": "line",
                "layers": [{"layerId": "layer1", "seriesType": "line", "xAccessor": "col-x", "accessors": ["col-1m", "col-5m", "col-15m"], "layerType": "data"}],
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-x": {"label": "Timestamp", "dataType": "date", "operationType": "date_histogram", "sourceField": "@timestamp", "isBucketed": True, "params": {"interval": "auto", "includeEmptyRows": True}},
                    "col-1m": {"label": "Load 1m", "dataType": "number", "operationType": "average", "sourceField": "system.load.1", "isBucketed": False, "params": {"format": {"id": "number"}}},
                    "col-5m": {"label": "Load 5m", "dataType": "number", "operationType": "average", "sourceField": "system.load.5", "isBucketed": False, "params": {"format": {"id": "number"}}},
                    "col-15m": {"label": "Load 15m", "dataType": "number", "operationType": "average", "sourceField": "system.load.15", "isBucketed": False, "params": {"format": {"id": "number"}}},
                },
                "columnOrder": ["col-x", "col-1m", "col-5m", "col-15m"],
                "incompleteColumns": {},
                "indexPatternId": "metrics-system-load",
            }}}},
        },
    },
    "references": [{"type": "index-pattern", "id": "metrics-system-load", "name": "indexpattern-datasource-layer-layer1"}],
})

# Queue Status
make_xy("Queue Status", "vis-queue-status", "bar",
    [{"layerId": "layer1", "seriesType": "bar", "xAccessor": "col-x", "accessors": ["col-y"], "layerType": "data"}],
    {"layer1": {
        "columns": {
            "col-x": {"label": "Status", "dataType": "string", "operationType": "terms", "sourceField": "status", "isBucketed": True, "params": {"size": 10, "orderBy": {"type": "column", "columnId": "col-y"}, "orderDirection": "desc"}},
            "col-y": {"label": "Count", "dataType": "number", "operationType": "count", "isBucketed": False, "params": {}},
        },
        "columnOrder": ["col-x", "col-y"],
        "incompleteColumns": {},
        "indexPatternId": "benchmarker-queue",
    }},
    "benchmarker-queue",
)

# --- Dashboards ---
print("Creating dashboards...")

def patch_lens_state_for_inline(state):
    """Ensure Lens state has all required fields for inline dashboard embedding."""
    state.setdefault("adHocDataViews", {})
    state.setdefault("internalReferences", [])
    ds = state.get("datasourceStates", {}).get("formBased", {})
    for layer in ds.get("layers", {}).values():
        layer.setdefault("sampling", 1)
        layer.setdefault("ignoreGlobalFilters", False)
        for col in layer.get("columns", {}).values():
            params = col.setdefault("params", {})
            if col.get("operationType") == "terms":
                params.setdefault("otherBucket", True)
                params.setdefault("missingBucket", False)
                params.setdefault("parentFormat", {"id": "terms"})
                params.setdefault("include", [])
                params.setdefault("exclude", [])
                params.setdefault("includeIsRegex", False)
                params.setdefault("excludeIsRegex", False)
            elif col.get("operationType") == "count":
                col.setdefault("sourceField", "___records___")
            elif col.get("operationType") == "date_histogram":
                params.setdefault("includeEmptyRows", True)
    return state


def fetch_lens_for_inline(vis_id):
    """Fetch a Lens saved object and return its inline embeddableConfig.

    Matches the format used by working Elastic Security dashboards in Kibana 9.x:
    - attributes: type, title, visualizationType, state, references (NO version)
    - embeddableConfig: attributes + enhancements + standard fields
    """
    result = subprocess.run([
        "curl", "-sf",
        f"{KIBANA_URL}/api/saved_objects/lens/{vis_id}",
        "-H", "kbn-xsrf: true", "-H", "Content-Type: application/json",
        "-u", f"{KIBANA_USER}:{KIBANA_PASS}",
    ], capture_output=True, text=True)
    if result.returncode != 0:
        return None, []
    obj = json.loads(result.stdout)
    attrs = obj.get("attributes", {})
    refs = obj.get("references", [])
    state = patch_lens_state_for_inline(attrs.get("state", {}))
    return {
        "title": attrs.get("title", ""),
        "visualizationType": attrs.get("visualizationType", ""),
        "state": state,
        "references": refs,
    }, refs


dashboards = [
    {
        "id": "benchmarker-results",
        "title": "Benchmark Results",
        "description": "Benchmark results comparison and key metrics by model",
        "time_from": "now-7d",
        "panels": [
            {"w": 48, "h": 15, "x": 0, "y": 0, "ref_type": "lens", "ref_id": "vis-results-table"},
            {"w": 16, "h": 12, "x": 0, "y": 15, "ref_type": "lens", "ref_id": "vis-throughput-bar"},
            {"w": 16, "h": 12, "x": 16, "y": 15, "ref_type": "lens", "ref_id": "vis-itl-bar"},
            {"w": 16, "h": 12, "x": 32, "y": 15, "ref_type": "lens", "ref_id": "vis-ttft-bar"},
        ],
    },
    {
        "id": "benchmarker-performance-trends",
        "title": "Performance Trends",
        "description": "Throughput and latency trends over time",
        "time_from": "now-7d",
        "panels": [
            {"w": 48, "h": 15, "x": 0, "y": 0, "ref_type": "lens", "ref_id": "vis-throughput-trend"},
        ],
    },
    {
        "id": "benchmarker-resource-usage",
        "title": "VM Resource Usage",
        "description": "GCP VM CPU, memory, and system load over time",
        "time_from": "now-24h",
        "panels": [
            {"w": 24, "h": 15, "x": 0, "y": 0, "ref_type": "lens", "ref_id": "vis-resource-cpu"},
            {"w": 24, "h": 15, "x": 24, "y": 0, "ref_type": "lens", "ref_id": "vis-resource-memory"},
            {"w": 48, "h": 15, "x": 0, "y": 15, "ref_type": "lens", "ref_id": "vis-resource-load"},
        ],
    },
    {
        "id": "benchmarker-queue-status",
        "title": "Queue & Status",
        "description": "Queue view and status breakdown",
        "time_from": "now-7d",
        "panels": [
            {"w": 48, "h": 15, "x": 0, "y": 0, "ref_type": "search", "ref_id": "search-queue-view"},
            {"w": 24, "h": 12, "x": 0, "y": 15, "ref_type": "lens", "ref_id": "vis-queue-status"},
        ],
    },
    {
        "id": "benchmarker-error-analysis",
        "title": "Error Analysis",
        "description": "Error events and analysis",
        "time_from": "now-7d",
        "panels": [
            {"w": 48, "h": 20, "x": 0, "y": 0, "ref_type": "search", "ref_id": "search-error-events"},
        ],
    },
    {
        "id": "benchmarker-gpu-usage",
        "title": "GPU Usage",
        "description": "GPU VRAM utilization across benchmarked models",
        "time_from": "now-30d",
        "panels": [
            {"w": 12, "h": 8, "x": 0, "y": 0, "ref_type": "lens", "ref_id": "vis-gpu-vram-gauge"},
            {"w": 36, "h": 12, "x": 0, "y": 8, "ref_type": "lens", "ref_id": "vis-gpu-vram-util"},
            {"w": 48, "h": 12, "x": 0, "y": 20, "ref_type": "lens", "ref_id": "vis-gpu-estimated-vs-actual"},
        ],
    },
]

print("  Cleaning up old dashboards...")
old_dashboard_ids = [
    "dashboard-benchmark-results", "dashboard-performance-trends",
    "dashboard-resource-usage", "dashboard-queue-status", "dashboard-error-analysis",
    "dashboard-benchmark-results-v2", "dash-fresh-test", "test-minimal-v3", "test-xy-table",
    "benchmarker-gpu-usage",
]
for old_id in old_dashboard_ids:
    delete("dashboard", old_id)
for d in dashboards:
    delete("dashboard", d["id"])
time.sleep(3)

for d in dashboards:
    panels_json = []
    refs = []
    for i, p in enumerate(d["panels"]):
        panel_id = str(i + 1)
        grid = {"x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"], "i": panel_id}

        if p["ref_type"] == "lens":
            lens_attrs, lens_refs = fetch_lens_for_inline(p["ref_id"])
            if lens_attrs:
                panel_refs = []
                for r in lens_refs:
                    panel_refs.append(r)
                    refs.append({"name": f"{panel_id}:{r['name']}", "type": r["type"], "id": r["id"]})
                inline_state = lens_attrs["state"]
                panels_json.append({
                    "type": "lens",
                    "gridData": grid,
                    "panelIndex": panel_id,
                    "embeddableConfig": {
                        "attributes": {
                            "type": "lens",
                            "title": lens_attrs["title"],
                            "visualizationType": lens_attrs["visualizationType"],
                            "state": inline_state,
                            "references": panel_refs,
                        },
                        "enhancements": {},
                    },
                })
            else:
                panels_json.append({
                    "type": "lens",
                    "gridData": grid,
                    "panelIndex": panel_id,
                    "embeddableConfig": {},
                    "panelRefName": f"panel_{i}",
                })
                refs.append({"name": f"panel_{i}", "type": "lens", "id": p["ref_id"]})
        else:
            panels_json.append({
                "type": p["ref_type"],
                "gridData": grid,
                "panelIndex": panel_id,
                "embeddableConfig": {},
                "panelRefName": f"panel_{i}",
            })
            refs.append({"name": f"panel_{i}", "type": p["ref_type"], "id": p["ref_id"]})

    create("dashboard", d["id"], {
        "attributes": {
            "title": d["title"],
            "description": d["description"],
            "optionsJSON": json.dumps({"hidePanelTitles": False, "useMargins": True}),
            "panelsJSON": json.dumps(panels_json),
            "timeRestore": True,
            "timeTo": "now",
            "timeFrom": d["time_from"],
        },
        "references": refs,
    }, skip_delete=True)

# --- Export non-dashboard objects to NDJSON ---
# NOTE: Dashboards with inline Lens panels cannot be reliably imported via NDJSON
# due to Kibana 9.x migration bugs. Use this script to deploy all objects.
print("\nExporting non-dashboard objects to NDJSON (backup)...")

non_dash_objects = []
for dv_id, _, _ in data_views:
    non_dash_objects.append({"type": "index-pattern", "id": dv_id})
for s in searches:
    non_dash_objects.append({"type": "search", "id": s["id"]})
for vis_id in ["vis-results-table", "vis-throughput-bar", "vis-itl-bar", "vis-ttft-bar",
                "vis-throughput-trend", "vis-resource-cpu", "vis-resource-memory", "vis-resource-load", "vis-queue-status",
                "vis-gpu-vram-util", "vis-gpu-estimated-vs-actual", "vis-gpu-vram-gauge"]:
    non_dash_objects.append({"type": "lens", "id": vis_id})

export_body = json.dumps({"objects": non_dash_objects, "includeReferencesDeep": False})
result = subprocess.run([
    "curl", "-s", "-X", "POST",
    f"{KIBANA_URL}/api/saved_objects/_export",
    "-H", "kbn-xsrf: true", "-H", "Content-Type: application/json",
    "-u", f"{KIBANA_USER}:{KIBANA_PASS}",
    "-d", export_body,
], capture_output=True, text=True)

script_dir = os.path.dirname(os.path.abspath(__file__))
output_path = os.path.join(script_dir, "..", "kibana", "saved-objects.ndjson")

lines = result.stdout.strip().split("\n")
export_lines = [l for l in lines if not l.startswith('{"excludedObjects')]

with open(output_path, "w") as f:
    f.write("\n".join(export_lines) + "\n")

print(f"Exported {len(export_lines)} objects to {output_path}")
print(f"Created {len(dashboards)} dashboards via API (not in NDJSON)")
print("Done!")
