#!/usr/bin/env bash
set -euo pipefail

KIBANA_URL="${KIBANA_URL:-http://localhost:5601}"
KIBANA_USER="${KIBANA_USER:-elastic}"
KIBANA_PASS="${KIBANA_PASS:-changeme}"
AUTH="-u ${KIBANA_USER}:${KIBANA_PASS}"

create() {
  local type=$1 id=$2
  shift 2
  curl -sf -X POST "${KIBANA_URL}/api/saved_objects/${type}/${id}" \
    -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    ${AUTH} -d "$1" > /dev/null
  echo "  Created ${type}/${id}"
}

delete_if_exists() {
  local type=$1 id=$2
  curl -sf -X DELETE "${KIBANA_URL}/api/saved_objects/${type}/${id}" \
    -H 'kbn-xsrf: true' ${AUTH} > /dev/null 2>&1 || true
}

echo "Creating data views..."
for idx in benchmarker-results benchmarker-eval-reports benchmarker-queue benchmarker-checkpoints benchmarker-models benchmarker-errors; do
  tf="@timestamp"
  [ "$idx" = "benchmarker-queue" ] && tf="requested_at"
  [ "$idx" = "benchmarker-models" ] && tf="discovered_at"
  delete_if_exists index-pattern "$idx"
  create index-pattern "$idx" "{\"attributes\":{\"title\":\"${idx}\",\"timeFieldName\":\"${tf}\"},\"references\":[]}"
done

delete_if_exists index-pattern logs-docker-container
create index-pattern logs-docker-container '{"attributes":{"title":"logs-docker.container_log-*","timeFieldName":"@timestamp"},"references":[]}'

delete_if_exists index-pattern metrics-system
create index-pattern metrics-system '{"attributes":{"title":"metrics-system.*","timeFieldName":"@timestamp"},"references":[]}'

echo "Creating saved searches..."

create_search() {
  local id=$1 title=$2 columns=$3 sort=$4 query=$5 index_ref=$6
  delete_if_exists search "$id"
  local search_source
  search_source=$(python3 -c "
import json
print(json.dumps({
  'query': {'language': 'kuery', 'query': '${query}'},
  'filter': [],
  'indexRefName': 'index_0'
}))
")
  local body
  body=$(python3 -c "
import json
body = {
    'attributes': {
        'title': '${title}',
        'tabs': [{
            'id': 'default',
            'attributes': {
                'kibanaSavedObjectMeta': {
                    'searchSourceJSON': json.dumps({
                        'query': {'language': 'kuery', 'query': '''${query}'''},
                        'filter': [],
                        'indexRefName': 'index_0'
                    })
                },
                'columns': ${columns},
                'sort': ${sort}
            }
        }]
    },
    'references': [{'name': 'index_0', 'type': 'index-pattern', 'id': '${index_ref}'}]
}
print(json.dumps(body))
")
  curl -sf -X POST "${KIBANA_URL}/api/saved_objects/search/${id}" \
    -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    ${AUTH} -d "${body}" > /dev/null
  echo "  Created search/${id}"
}

create_search "search-queue-view" "Queue View" \
  '["model_id","status","priority","requested_at","started_at","completed_at","requested_by"]' \
  '[["priority","desc"]]' \
  "" \
  "benchmarker-queue"

create_search "search-container-logs" "Container Logs" \
  '["@timestamp","message","container.name","log.level"]' \
  '[["@timestamp","desc"]]' \
  '*OOM* or *oom* or *CUDA* or *cuda* or *Out of memory*' \
  "logs-docker-container"

create_search "search-model-catalog" "Model Catalog" \
  '["model_id","name","architecture","parameter_count_billions","context_window","license","supports_tool_calling","source"]' \
  '[["model_id","asc"]]' \
  "" \
  "benchmarker-models"

create_search "search-error-events" "Error Events" \
  '["@timestamp","model_id","error_category","error_message","recovery_action","attempt_number","success","node_name"]' \
  '[["@timestamp","desc"]]' \
  "" \
  "benchmarker-errors"

echo "Creating Lens visualizations..."

create_lens() {
  local id=$1
  shift
  delete_if_exists lens "$id"
  curl -sf -X POST "${KIBANA_URL}/api/saved_objects/lens/${id}" \
    -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    ${AUTH} -d "$1" > /dev/null
  echo "  Created lens/${id}"
}

create_lens "vis-results-table" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Results Comparison Table',
        'visualizationType': 'lnsDatatable',
        'state': {
            'visualization': {
                'layerId': 'layer1',
                'layerType': 'data',
                'columns': [{'columnId': c} for c in ['col1','col2','col3','col4','col5','col6']]
            },
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {
                'formBased': {
                    'layers': {
                        'layer1': {
                            'columns': {
                                'col1': {'label': 'Model', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'model_id', 'isBucketed': True, 'params': {'size': 50, 'orderBy': {'type': 'column', 'columnId': 'col2'}, 'orderDirection': 'desc'}},
                                'col2': {'label': 'Timestamp', 'dataType': 'date', 'operationType': 'last_value', 'sourceField': '@timestamp', 'isBucketed': False, 'params': {'sortField': '@timestamp', 'format': {'id': 'date'}}},
                                'col3': {'label': 'Passed', 'dataType': 'boolean', 'operationType': 'last_value', 'sourceField': 'passed', 'isBucketed': False, 'params': {'sortField': '@timestamp'}},
                                'col4': {'label': 'Throughput (tok/s)', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.throughput_tokens_per_sec', 'isBucketed': False, 'params': {'format': {'id': 'number'}}},
                                'col5': {'label': 'ITL (ms)', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.itl_ms', 'isBucketed': False, 'params': {'format': {'id': 'number'}}},
                                'col6': {'label': 'TTFT (ms)', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.ttft_ms', 'isBucketed': False, 'params': {'format': {'id': 'number'}}}
                            },
                            'columnOrder': ['col1','col2','col3','col4','col5','col6'],
                            'incompleteColumns': {},
                            'indexPatternId': 'benchmarker-results'
                        }
                    }
                }
            }
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-results', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-throughput-bar" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Throughput Bar Chart',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'show', 'preferredSeriesType': 'bar_stacked', 'layers': [{'layerId': 'layer1', 'seriesType': 'bar', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Model', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'model_id', 'isBucketed': True, 'params': {'size': 20, 'orderBy': {'type': 'column', 'columnId': 'col-y'}, 'orderDirection': 'desc'}},
                    'col-y': {'label': 'Avg Throughput', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.throughput_tokens_per_sec', 'isBucketed': False, 'params': {'format': {'id': 'number'}}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'benchmarker-results'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-results', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-itl-bar" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'ITL Bar Chart',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'show', 'preferredSeriesType': 'bar_stacked', 'layers': [{'layerId': 'layer1', 'seriesType': 'bar', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Model', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'model_id', 'isBucketed': True, 'params': {'size': 20, 'orderBy': {'type': 'column', 'columnId': 'col-y'}, 'orderDirection': 'asc'}},
                    'col-y': {'label': 'Avg ITL (ms)', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.itl_ms', 'isBucketed': False, 'params': {'format': {'id': 'number'}}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'benchmarker-results'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-results', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-ttft-bar" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'TTFT Bar Chart',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'show', 'preferredSeriesType': 'bar_stacked', 'layers': [{'layerId': 'layer1', 'seriesType': 'bar', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Model', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'model_id', 'isBucketed': True, 'params': {'size': 20, 'orderBy': {'type': 'column', 'columnId': 'col-y'}, 'orderDirection': 'asc'}},
                    'col-y': {'label': 'Avg TTFT (ms)', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.ttft_ms', 'isBucketed': False, 'params': {'format': {'id': 'number'}}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'benchmarker-results'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-results', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-throughput-trend" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Throughput Trend',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'hide', 'preferredSeriesType': 'line', 'layers': [{'layerId': 'layer1', 'seriesType': 'line', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'splitAccessor': 'col-z', 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Timestamp', 'dataType': 'date', 'operationType': 'date_histogram', 'sourceField': '@timestamp', 'isBucketed': True, 'params': {'interval': 'auto', 'includeEmptyRows': True}},
                    'col-y': {'label': 'Avg Throughput', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'benchmark_metrics.throughput_tokens_per_sec', 'isBucketed': False, 'params': {'format': {'id': 'number'}}},
                    'col-z': {'label': 'Model', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'model_id', 'isBucketed': True, 'params': {'size': 10, 'orderBy': {'type': 'alphabetical'}, 'orderDirection': 'asc'}}
                },
                'columnOrder': ['col-x', 'col-z', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'benchmarker-results'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-results', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-resource-cpu" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Resource CPU',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'hide', 'preferredSeriesType': 'line', 'layers': [{'layerId': 'layer1', 'seriesType': 'line', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Timestamp', 'dataType': 'date', 'operationType': 'date_histogram', 'sourceField': '@timestamp', 'isBucketed': True, 'params': {'interval': 'auto', 'includeEmptyRows': True}},
                    'col-y': {'label': 'CPU %', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'system.cpu.total.pct', 'isBucketed': False, 'params': {'format': {'id': 'percent'}}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'metrics-system'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'metrics-system', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-resource-memory" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Resource Memory',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'hide', 'preferredSeriesType': 'line', 'layers': [{'layerId': 'layer1', 'seriesType': 'line', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Timestamp', 'dataType': 'date', 'operationType': 'date_histogram', 'sourceField': '@timestamp', 'isBucketed': True, 'params': {'interval': 'auto', 'includeEmptyRows': True}},
                    'col-y': {'label': 'Memory Used %', 'dataType': 'number', 'operationType': 'average', 'sourceField': 'system.memory.used.pct', 'isBucketed': False, 'params': {'format': {'id': 'percent'}}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'metrics-system'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'metrics-system', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

create_lens "vis-queue-status" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Queue Status',
        'visualizationType': 'lnsXY',
        'state': {
            'visualization': {'legend': {'isVisible': True, 'position': 'right'}, 'valueLabels': 'show', 'preferredSeriesType': 'bar_stacked', 'layers': [{'layerId': 'layer1', 'seriesType': 'bar', 'xAccessor': 'col-x', 'accessors': ['col-y'], 'layerType': 'data'}]},
            'query': {'query': '', 'language': 'kuery'},
            'filters': [],
            'datasourceStates': {'formBased': {'layers': {'layer1': {
                'columns': {
                    'col-x': {'label': 'Status', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'status', 'isBucketed': True, 'params': {'size': 10, 'orderBy': {'type': 'column', 'columnId': 'col-y'}, 'orderDirection': 'desc'}},
                    'col-y': {'label': 'Count', 'dataType': 'number', 'operationType': 'count', 'isBucketed': False, 'params': {}}
                },
                'columnOrder': ['col-x', 'col-y'],
                'incompleteColumns': {},
                'indexPatternId': 'benchmarker-queue'
            }}}}
        }
    },
    'references': [{'type': 'index-pattern', 'id': 'benchmarker-queue', 'name': 'indexpattern-datasource-layer-layer1'}]
}
print(json.dumps(body))
")"

echo "Creating dashboards..."

create_dashboard() {
  local id=$1
  shift
  delete_if_exists dashboard "$id"
  curl -sf -X POST "${KIBANA_URL}/api/saved_objects/dashboard/${id}" \
    -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    ${AUTH} -d "$1" > /dev/null
  echo "  Created dashboard/${id}"
}

create_dashboard "dashboard-benchmark-results" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Benchmark Results',
        'description': 'Benchmark results comparison and key metrics by model',
        'optionsJSON': json.dumps({'hidePanelTitles': False, 'useMargins': True}),
        'panelsJSON': json.dumps([
            {'version': '8.0.0', 'gridData': {'x':0,'y':0,'w':48,'h':15,'i':'1'}, 'panelIndex': '1', 'embeddableConfig': {}, 'panelRefName': 'panel_0'},
            {'version': '8.0.0', 'gridData': {'x':0,'y':15,'w':16,'h':12,'i':'2'}, 'panelIndex': '2', 'embeddableConfig': {}, 'panelRefName': 'panel_1'},
            {'version': '8.0.0', 'gridData': {'x':16,'y':15,'w':16,'h':12,'i':'3'}, 'panelIndex': '3', 'embeddableConfig': {}, 'panelRefName': 'panel_2'},
            {'version': '8.0.0', 'gridData': {'x':32,'y':15,'w':16,'h':12,'i':'4'}, 'panelIndex': '4', 'embeddableConfig': {}, 'panelRefName': 'panel_3'}
        ]),
        'timeRestore': True, 'timeTo': 'now', 'timeFrom': 'now-7d'
    },
    'references': [
        {'name': 'panel_0', 'type': 'lens', 'id': 'vis-results-table'},
        {'name': 'panel_1', 'type': 'lens', 'id': 'vis-throughput-bar'},
        {'name': 'panel_2', 'type': 'lens', 'id': 'vis-itl-bar'},
        {'name': 'panel_3', 'type': 'lens', 'id': 'vis-ttft-bar'}
    ]
}
print(json.dumps(body))
")"

create_dashboard "dashboard-performance-trends" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Performance Trends',
        'description': 'Throughput and latency trends over time',
        'optionsJSON': json.dumps({'hidePanelTitles': False, 'useMargins': True}),
        'panelsJSON': json.dumps([
            {'version': '8.0.0', 'gridData': {'x':0,'y':0,'w':48,'h':15,'i':'1'}, 'panelIndex': '1', 'embeddableConfig': {}, 'panelRefName': 'panel_0'}
        ]),
        'timeRestore': True, 'timeTo': 'now', 'timeFrom': 'now-7d'
    },
    'references': [{'name': 'panel_0', 'type': 'lens', 'id': 'vis-throughput-trend'}]
}
print(json.dumps(body))
")"

create_dashboard "dashboard-resource-usage" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Resource Usage',
        'description': 'CPU and memory utilization over time',
        'optionsJSON': json.dumps({'hidePanelTitles': False, 'useMargins': True}),
        'panelsJSON': json.dumps([
            {'version': '8.0.0', 'gridData': {'x':0,'y':0,'w':24,'h':15,'i':'1'}, 'panelIndex': '1', 'embeddableConfig': {}, 'panelRefName': 'panel_0'},
            {'version': '8.0.0', 'gridData': {'x':24,'y':0,'w':24,'h':15,'i':'2'}, 'panelIndex': '2', 'embeddableConfig': {}, 'panelRefName': 'panel_1'}
        ]),
        'timeRestore': True, 'timeTo': 'now', 'timeFrom': 'now-24h'
    },
    'references': [
        {'name': 'panel_0', 'type': 'lens', 'id': 'vis-resource-cpu'},
        {'name': 'panel_1', 'type': 'lens', 'id': 'vis-resource-memory'}
    ]
}
print(json.dumps(body))
")"

create_dashboard "dashboard-queue-status" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Queue & Status',
        'description': 'Queue view and status breakdown',
        'optionsJSON': json.dumps({'hidePanelTitles': False, 'useMargins': True}),
        'panelsJSON': json.dumps([
            {'version': '8.0.0', 'gridData': {'x':0,'y':0,'w':48,'h':15,'i':'1'}, 'panelIndex': '1', 'embeddableConfig': {}, 'panelRefName': 'panel_0'},
            {'version': '8.0.0', 'gridData': {'x':0,'y':15,'w':24,'h':12,'i':'2'}, 'panelIndex': '2', 'embeddableConfig': {}, 'panelRefName': 'panel_1'}
        ]),
        'timeRestore': True, 'timeTo': 'now', 'timeFrom': 'now-7d'
    },
    'references': [
        {'name': 'panel_0', 'type': 'search', 'id': 'search-queue-view'},
        {'name': 'panel_1', 'type': 'lens', 'id': 'vis-queue-status'}
    ]
}
print(json.dumps(body))
")"

create_dashboard "dashboard-error-analysis" "$(python3 -c "
import json
body = {
    'attributes': {
        'title': 'Error Analysis',
        'description': 'Error events and analysis',
        'optionsJSON': json.dumps({'hidePanelTitles': False, 'useMargins': True}),
        'panelsJSON': json.dumps([
            {'version': '8.0.0', 'gridData': {'x':0,'y':0,'w':48,'h':20,'i':'1'}, 'panelIndex': '1', 'embeddableConfig': {}, 'panelRefName': 'panel_0'}
        ]),
        'timeRestore': True, 'timeTo': 'now', 'timeFrom': 'now-7d'
    },
    'references': [{'name': 'panel_0', 'type': 'search', 'id': 'search-error-events'}]
}
print(json.dumps(body))
")"

echo ""
echo "All objects created. Exporting to kibana/saved-objects.ndjson..."

ALL_IDS='{"objects":['
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-results"},'
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-eval-reports"},'
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-queue"},'
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-checkpoints"},'
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-models"},'
ALL_IDS+='{"type":"index-pattern","id":"benchmarker-errors"},'
ALL_IDS+='{"type":"index-pattern","id":"logs-docker-container"},'
ALL_IDS+='{"type":"index-pattern","id":"metrics-system"},'
ALL_IDS+='{"type":"search","id":"search-queue-view"},'
ALL_IDS+='{"type":"search","id":"search-container-logs"},'
ALL_IDS+='{"type":"search","id":"search-model-catalog"},'
ALL_IDS+='{"type":"search","id":"search-error-events"},'
ALL_IDS+='{"type":"lens","id":"vis-results-table"},'
ALL_IDS+='{"type":"lens","id":"vis-throughput-bar"},'
ALL_IDS+='{"type":"lens","id":"vis-itl-bar"},'
ALL_IDS+='{"type":"lens","id":"vis-ttft-bar"},'
ALL_IDS+='{"type":"lens","id":"vis-throughput-trend"},'
ALL_IDS+='{"type":"lens","id":"vis-resource-cpu"},'
ALL_IDS+='{"type":"lens","id":"vis-resource-memory"},'
ALL_IDS+='{"type":"lens","id":"vis-queue-status"},'
ALL_IDS+='{"type":"dashboard","id":"dashboard-benchmark-results"},'
ALL_IDS+='{"type":"dashboard","id":"dashboard-performance-trends"},'
ALL_IDS+='{"type":"dashboard","id":"dashboard-resource-usage"},'
ALL_IDS+='{"type":"dashboard","id":"dashboard-queue-status"},'
ALL_IDS+='{"type":"dashboard","id":"dashboard-error-analysis"}'
ALL_IDS+='],"includeReferencesDeep":false}'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${SCRIPT_DIR}/../kibana/saved-objects.ndjson"

curl -s -X POST "${KIBANA_URL}/api/saved_objects/_export" \
  -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
  ${AUTH} -d "${ALL_IDS}" | head -n -1 > "${OUTPUT}"

LINES=$(wc -l < "${OUTPUT}")
echo "Exported ${LINES} objects to ${OUTPUT}"
echo "Done!"
