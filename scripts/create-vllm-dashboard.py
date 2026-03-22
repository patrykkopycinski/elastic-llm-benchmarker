#!/usr/bin/env python3
"""Create Kibana dashboard for vLLM observability (EDOT Collector metrics).

Uses "dashboard as code" approach: all Lens visualizations are embedded
by-value in the dashboard panels, no separate saved objects needed.

Metrics source: metrics-prometheusreceiver.otel-* (EDOT Collector Prometheus receiver)
Annotations source: benchmarker-deployments (deploy/stop events)
"""

import json
import os
import subprocess
import sys
import time

KIBANA_URL = os.environ.get("KIBANA_URL", "http://localhost:5603")
KIBANA_USER = os.environ.get("KIBANA_USER", "elastic")
KIBANA_PASS = os.environ.get("KIBANA_PASS", "changeme")

METRICS_DV_ID = "vllm-metrics"
METRICS_DV_TITLE = "metrics-prometheusreceiver.otel-*"
DEPLOY_DV_ID = "benchmarker-deployments"
DEPLOY_DV_TITLE = "benchmarker-deployments"

# ─── Helpers ────────────────────────────────────────────────────────────────────

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
        if result.stderr:
            print(f"  stderr: {result.stderr[:500]}", file=sys.stderr)
        if result.stdout:
            print(f"  stdout: {result.stdout[:500]}", file=sys.stderr)
        return None
    return json.loads(result.stdout) if result.stdout.strip() else None


def delete_so(obj_type, obj_id):
    subprocess.run([
        "curl", "-sf", "-X", "DELETE",
        f"{KIBANA_URL}/api/saved_objects/{obj_type}/{obj_id}?force=true",
        "-H", "kbn-xsrf: true",
        "-u", f"{KIBANA_USER}:{KIBANA_PASS}",
    ], capture_output=True)
    time.sleep(0.15)


# ─── Data Views ─────────────────────────────────────────────────────────────────

print("Creating data views...")

for dv_id, title, time_field in [
    (METRICS_DV_ID, METRICS_DV_TITLE, "@timestamp"),
    (DEPLOY_DV_ID, DEPLOY_DV_TITLE, "@timestamp"),
]:
    delete_so("index-pattern", dv_id)
    result = api("POST", "/api/data_views/data_view", {
        "data_view": {"id": dv_id, "title": title, "timeFieldName": time_field},
        "override": True,
    })
    if result:
        print(f"  Created data view: {dv_id}")


# ─── Annotation layer (shared across XY charts) ────────────────────────────────

def annotation_layer():
    """Returns the persisted annotation layer config + its references.

    Kibana Lens persistence format (from xy/persistence.ts):
    - indexPatternId is stripped from the layer and stored in references
    - Reference name: xy-visualization-layer-{layerId}
    - Layer gets persistanceType: "byValue" (note the typo is intentional, matches Kibana source)
    """
    layer_id = "annotations"
    layer = {
        "layerId": layer_id,
        "layerType": "annotations",
        "persistanceType": "byValue",
        "annotations": [{
            "type": "query",
            "id": "ann-deployed",
            "label": "Model deployed",
            "key": {"type": "point_in_time"},
            "icon": "alert",
            "color": "#54B399",
            "lineStyle": "solid",
            "lineWidth": 2,
            "timeField": "@timestamp",
            "textVisibility": True,
            "textField": "label",
            "filter": {"type": "kibana_filter", "query": "event: deployed", "language": "kuery"},
        }, {
            "type": "query",
            "id": "ann-stopped",
            "label": "Model stopped",
            "key": {"type": "point_in_time"},
            "icon": "circle",
            "color": "#E7664C",
            "lineStyle": "dashed",
            "lineWidth": 2,
            "timeField": "@timestamp",
            "textVisibility": True,
            "textField": "label",
            "filter": {"type": "kibana_filter", "query": "event: stopped", "language": "kuery"},
        }],
        "ignoreGlobalFilters": False,
    }
    refs = [
        {"type": "index-pattern", "id": DEPLOY_DV_ID, "name": f"xy-visualization-layer-{layer_id}"},
    ]
    return layer, refs


# ─── Panel builders ─────────────────────────────────────────────────────────────

def gauge_panel(title, field, fmt="number"):
    """Metric (gauge) panel showing last value of a field.

    Each OTel metric doc only contains one metric type, so we must filter
    to docs where the specific field exists before doing last_value.
    """
    return {
        "type": "lens",
        "title": title,
        "visualizationType": "lnsMetric",
        "state": {
            "visualization": {
                "layerId": "layer1", "layerType": "data",
                "metricAccessor": "col-val",
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-val": {
                        "label": title, "dataType": "number",
                        "operationType": "last_value", "sourceField": field,
                        "isBucketed": False,
                        "params": {"sortField": "@timestamp", "format": {"id": fmt}},
                        "filter": {"type": "kibana_filter", "query": f'"{field}": *', "language": "kuery"},
                    },
                },
                "columnOrder": ["col-val"],
                "incompleteColumns": {},
                "indexPatternId": METRICS_DV_ID,
            }}}},
            "adHocDataViews": {},
            "internalReferences": [],
        },
        "references": [
            {"type": "index-pattern", "id": METRICS_DV_ID, "name": "indexpattern-datasource-layer-layer1"},
        ],
    }


def timeseries_panel(title, series, series_type="line", with_annotations=True):
    """XY time-series panel with optional deploy/stop annotations."""
    accessors = [s["id"] for s in series]
    columns = {
        "col-x": {
            "label": "Timestamp", "dataType": "date",
            "operationType": "date_histogram", "sourceField": "@timestamp",
            "isBucketed": True, "params": {"interval": "auto", "includeEmptyRows": True},
        },
    }
    for s in series:
        col = {
            "label": s["label"], "dataType": "number",
            "operationType": s.get("op", "average"), "sourceField": s["field"],
            "isBucketed": False,
            "params": {"format": {"id": s.get("fmt", "number")}},
            "filter": {"type": "kibana_filter", "query": f'"{s["field"]}": *', "language": "kuery"},
        }
        if s.get("op") == "last_value":
            col["params"]["sortField"] = "@timestamp"
        columns[s["id"]] = col

    layers = [{
        "layerId": "layer1", "seriesType": series_type,
        "xAccessor": "col-x", "accessors": accessors, "layerType": "data",
    }]

    refs = [
        {"type": "index-pattern", "id": METRICS_DV_ID, "name": "indexpattern-datasource-layer-layer1"},
    ]

    if with_annotations:
        ann_layer, ann_refs = annotation_layer()
        layers.append(ann_layer)
        refs.extend(ann_refs)

    return {
        "type": "lens",
        "title": title,
        "visualizationType": "lnsXY",
        "state": {
            "visualization": {
                "legend": {"isVisible": True, "position": "right"},
                "valueLabels": "hide",
                "preferredSeriesType": series_type,
                "layers": layers,
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {
                "layer1": {
                    "columns": columns,
                    "columnOrder": ["col-x"] + accessors,
                    "incompleteColumns": {},
                    "indexPatternId": METRICS_DV_ID,
                },
            }}},
            "adHocDataViews": {},
            "internalReferences": [],
        },
        "references": refs,
    }


def deploy_timeline_panel():
    """Bar chart showing deploy/stop events on a time axis."""
    return {
        "type": "lens",
        "title": "Model Deployment Timeline",
        "visualizationType": "lnsXY",
        "state": {
            "visualization": {
                "legend": {"isVisible": True, "position": "right"},
                "valueLabels": "hide",
                "preferredSeriesType": "bar_stacked",
                "layers": [{
                    "layerId": "layer1", "seriesType": "bar_stacked",
                    "xAccessor": "col-x", "accessors": ["col-count"],
                    "splitAccessor": "col-label",
                    "layerType": "data",
                }],
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-x": {
                        "label": "Time", "dataType": "date",
                        "operationType": "date_histogram", "sourceField": "@timestamp",
                        "isBucketed": True, "params": {"interval": "auto", "includeEmptyRows": True},
                    },
                    "col-label": {
                        "label": "Event", "dataType": "string",
                        "operationType": "terms", "sourceField": "label",
                        "isBucketed": True,
                        "params": {"size": 20, "orderBy": {"type": "column", "columnId": "col-count"}, "orderDirection": "desc"},
                    },
                    "col-count": {
                        "label": "Events", "dataType": "number",
                        "operationType": "count", "sourceField": "___records___",
                        "isBucketed": False,
                    },
                },
                "columnOrder": ["col-x", "col-label", "col-count"],
                "incompleteColumns": {},
                "indexPatternId": DEPLOY_DV_ID,
            }}}},
            "adHocDataViews": {},
            "internalReferences": [],
        },
        "references": [
            {"type": "index-pattern", "id": DEPLOY_DV_ID, "name": "indexpattern-datasource-layer-layer1"},
        ],
    }


def deploy_table_panel():
    """Table showing deployment event details."""
    return {
        "type": "lens",
        "title": "Deployment Events",
        "visualizationType": "lnsDatatable",
        "state": {
            "visualization": {
                "layerId": "layer1", "layerType": "data",
                "columns": [
                    {"columnId": "col-ts"},
                    {"columnId": "col-event"},
                    {"columnId": "col-model"},
                    {"columnId": "col-tp"},
                    {"columnId": "col-gpu"},
                    {"columnId": "col-count"},
                ],
            },
            "query": {"query": "", "language": "kuery"},
            "filters": [],
            "datasourceStates": {"formBased": {"layers": {"layer1": {
                "columns": {
                    "col-ts": {
                        "label": "Time", "dataType": "date",
                        "operationType": "date_histogram", "sourceField": "@timestamp",
                        "isBucketed": True, "params": {"interval": "1m", "includeEmptyRows": False},
                    },
                    "col-event": {
                        "label": "Event", "dataType": "string",
                        "operationType": "terms", "sourceField": "event",
                        "isBucketed": True,
                        "params": {"size": 20, "orderBy": {"type": "alphabetical"}, "orderDirection": "asc"},
                    },
                    "col-model": {
                        "label": "Model", "dataType": "string",
                        "operationType": "terms", "sourceField": "model_id",
                        "isBucketed": True,
                        "params": {"size": 20, "orderBy": {"type": "alphabetical"}, "orderDirection": "asc"},
                    },
                    "col-tp": {
                        "label": "TP Size", "dataType": "number",
                        "operationType": "max", "sourceField": "tensor_parallel_size",
                        "isBucketed": False,
                    },
                    "col-gpu": {
                        "label": "GPU", "dataType": "string",
                        "operationType": "terms", "sourceField": "gpu_type",
                        "isBucketed": True,
                        "params": {"size": 5, "orderBy": {"type": "alphabetical"}, "orderDirection": "asc"},
                    },
                    "col-count": {
                        "label": "Count", "dataType": "number",
                        "operationType": "count", "sourceField": "___records___",
                        "isBucketed": False,
                    },
                },
                "columnOrder": ["col-ts", "col-event", "col-model", "col-tp", "col-gpu", "col-count"],
                "incompleteColumns": {},
                "indexPatternId": DEPLOY_DV_ID,
            }}}},
            "adHocDataViews": {},
            "internalReferences": [],
        },
        "references": [
            {"type": "index-pattern", "id": DEPLOY_DV_ID, "name": "indexpattern-datasource-layer-layer1"},
        ],
    }


# ─── Build all panels ───────────────────────────────────────────────────────────

print("\nBuilding dashboard panels...")

PANEL_DEFS = [
    # Row 0: Deployment events (full width)
    {"attrs": deploy_timeline_panel(),  "x": 0,  "y": 0,  "w": 30, "h": 8},
    {"attrs": deploy_table_panel(),     "x": 30, "y": 0,  "w": 18, "h": 8},

    # Row 1: KPI gauges
    {"attrs": gauge_panel("GPU KV Cache Usage", "metrics.vllm:kv_cache_usage_perc", "percent"),
     "x": 0, "y": 8, "w": 12, "h": 8},
    {"attrs": gauge_panel("Running Requests", "metrics.vllm:num_requests_running"),
     "x": 12, "y": 8, "w": 12, "h": 8},
    {"attrs": gauge_panel("Waiting Requests", "metrics.vllm:num_requests_waiting"),
     "x": 24, "y": 8, "w": 12, "h": 8},
    {"attrs": gauge_panel("Successful Requests", "metrics.vllm:request_success_total"),
     "x": 36, "y": 8, "w": 12, "h": 8},

    # Row 2: Latency charts
    {"attrs": timeseries_panel("E2E Request Latency", [
        {"id": "col-lat", "label": "E2E Latency (avg s)", "field": "metrics.vllm:e2e_request_latency_seconds"},
    ]), "x": 0, "y": 16, "w": 16, "h": 12},
    {"attrs": timeseries_panel("Time to First Token", [
        {"id": "col-ttft", "label": "TTFT (avg s)", "field": "metrics.vllm:time_to_first_token_seconds"},
    ]), "x": 16, "y": 16, "w": 16, "h": 12},
    {"attrs": timeseries_panel("Inter-Token Latency", [
        {"id": "col-itl", "label": "ITL (avg s)", "field": "metrics.vllm:inter_token_latency_seconds"},
    ]), "x": 32, "y": 16, "w": 16, "h": 12},

    # Row 3: Resource usage
    {"attrs": timeseries_panel("KV Cache Usage Over Time", [
        {"id": "col-kv", "label": "KV Cache %", "field": "metrics.vllm:kv_cache_usage_perc", "op": "last_value", "fmt": "percent"},
    ], series_type="area"), "x": 0, "y": 28, "w": 24, "h": 12},
    {"attrs": timeseries_panel("Running & Waiting Requests", [
        {"id": "col-run", "label": "Running", "field": "metrics.vllm:num_requests_running", "op": "last_value"},
        {"id": "col-wait", "label": "Waiting", "field": "metrics.vllm:num_requests_waiting", "op": "last_value"},
    ], series_type="area"), "x": 24, "y": 28, "w": 24, "h": 12},

    # Row 4: Throughput & timing
    {"attrs": timeseries_panel("Token Throughput (cumulative)", [
        {"id": "col-prompt", "label": "Prompt Tokens", "field": "metrics.vllm:prompt_tokens_total", "op": "last_value"},
        {"id": "col-gen", "label": "Generation Tokens", "field": "metrics.vllm:generation_tokens_total", "op": "last_value"},
    ]), "x": 0, "y": 40, "w": 16, "h": 12},
    {"attrs": timeseries_panel("Prefill & Decode Time", [
        {"id": "col-prefill", "label": "Prefill (avg s)", "field": "metrics.vllm:request_prefill_time_seconds"},
        {"id": "col-decode", "label": "Decode (avg s)", "field": "metrics.vllm:request_decode_time_seconds"},
    ]), "x": 16, "y": 40, "w": 16, "h": 12},
    {"attrs": timeseries_panel("Request Queue Time", [
        {"id": "col-q", "label": "Queue Time (avg s)", "field": "metrics.vllm:request_queue_time_seconds"},
    ]), "x": 32, "y": 40, "w": 16, "h": 12},

    # Row 5: Cache & success
    {"attrs": timeseries_panel("Request Success (cumulative)", [
        {"id": "col-succ", "label": "Successful Requests", "field": "metrics.vllm:request_success_total", "op": "last_value"},
    ]), "x": 0, "y": 52, "w": 24, "h": 12},
    {"attrs": timeseries_panel("Cache Hit Rates", [
        {"id": "col-pq", "label": "Prefix Queries", "field": "metrics.vllm:prefix_cache_queries_total", "op": "last_value"},
        {"id": "col-ph", "label": "Prefix Hits", "field": "metrics.vllm:prefix_cache_hits_total", "op": "last_value"},
    ]), "x": 24, "y": 52, "w": 24, "h": 12},

    # Row 6: GPU Cache utilization
    {"attrs": timeseries_panel("GPU Cache Usage Over Time", [
        {"id": "col-gpu-cache", "label": "GPU Cache %", "field": "metrics.vllm:gpu_cache_usage_perc", "op": "last_value", "fmt": "percent"},
    ], series_type="area"), "x": 0, "y": 64, "w": 24, "h": 12},
    {"attrs": gauge_panel("GPU Cache Usage", "metrics.vllm:gpu_cache_usage_perc", "percent"),
     "x": 24, "y": 64, "w": 12, "h": 8},
]


# ─── Assemble dashboard ─────────────────────────────────────────────────────────

panels_json = []
for i, p in enumerate(PANEL_DEFS):
    attrs = p["attrs"]
    panels_json.append({
        "type": "lens",
        "gridData": {"x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"], "i": str(i)},
        "panelIndex": str(i),
        "embeddableConfig": {
            "attributes": attrs,
            "enhancements": {},
        },
    })

dashboard_body = {
    "attributes": {
        "title": "vLLM Inference Observability",
        "description": "Real-time vLLM metrics from EDOT Collector. Deployment events mark model deploy/stop.",
        "panelsJSON": json.dumps(panels_json),
        "optionsJSON": json.dumps({
            "useMargins": True,
            "syncColors": False,
            "syncCursor": True,
            "syncTooltips": True,
            "hidePanelTitles": False,
        }),
        "timeRestore": True,
        "timeTo": "now",
        "timeFrom": "now-1h",
        "refreshInterval": {"pause": False, "value": 15000},
        "kibanaSavedObjectMeta": {
            "searchSourceJSON": json.dumps({"query": {"query": "", "language": "kuery"}, "filter": []}),
        },
    },
}

print("\nCreating dashboard...")

# Clean up old by-reference visualizations if they exist
old_vis_ids = [
    "vllm-kv-cache-gauge", "vllm-running-gauge", "vllm-waiting-gauge",
    "vllm-e2e-latency", "vllm-ttft", "vllm-itl", "vllm-kv-cache-ts",
    "vllm-requests-ts", "vllm-tokens-ts", "vllm-prefill-decode",
    "vllm-queue-time", "vllm-success-ts", "vllm-cache-hits",
    "vllm-deploy-timeline", "vllm-deploy-table",
]
for vid in old_vis_ids:
    delete_so("lens", vid)
print("  Cleaned up old by-reference visualizations")

delete_so("dashboard", "vllm-observability")
result = api("POST", "/api/saved_objects/dashboard/vllm-observability", dashboard_body)
if result:
    print(f"  Created dashboard/vllm-observability")
else:
    print("  FAILED to create dashboard", file=sys.stderr)
    sys.exit(1)

print(f"\n✓ Dashboard 'vLLM Inference Observability' created successfully!")
print(f"  Open: {KIBANA_URL}/app/dashboards#/view/vllm-observability")
print(f"  Panels: {len(PANEL_DEFS)} (all by-value, no separate saved objects)")
