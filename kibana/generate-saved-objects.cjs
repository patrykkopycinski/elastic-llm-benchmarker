#!/usr/bin/env node
/**
 * Generates Kibana saved objects NDJSON file with valid JSON per line.
 */
const fs = require('fs');

const lines = [];

// Data views
const dataViews = [
  { id: 'benchmarker-results', title: 'benchmarker-results', timeFieldName: '@timestamp' },
  { id: 'benchmarker-eval-reports', title: 'benchmarker-eval-reports', timeFieldName: '@timestamp' },
  { id: 'benchmarker-queue', title: 'benchmarker-queue', timeFieldName: 'requested_at' },
  { id: 'benchmarker-checkpoints', title: 'benchmarker-checkpoints', timeFieldName: '@timestamp' },
  { id: 'benchmarker-models', title: 'benchmarker-models', timeFieldName: 'discovered_at' },
  { id: 'benchmarker-errors', title: 'benchmarker-errors', timeFieldName: '@timestamp' },
  { id: 'logs-docker-container', title: 'logs-docker.container_log-*', timeFieldName: '@timestamp' },
  { id: 'metrics-system', title: 'metrics-system.*', timeFieldName: '@timestamp' },
];
for (const dv of dataViews) {
  lines.push(JSON.stringify({ type: 'index-pattern', id: dv.id, attributes: { title: dv.title, timeFieldName: dv.timeFieldName }, references: [] }));
}

// Saved searches
const searches = [
  { id: 'search-queue-view', title: 'Queue View', indexId: 'benchmarker-queue', columns: ['model_id', 'status', 'priority', 'requested_at', 'started_at', 'completed_at', 'requested_by'], sort: [['priority', 'desc']], query: '' },
  { id: 'search-container-logs', title: 'Container Logs', indexId: 'logs-docker-container', columns: ['@timestamp', 'message', 'container.name', 'log.level'], sort: [['@timestamp', 'desc']], query: 'message:(*OOM* or *oom* or *CUDA* or *cuda* or *Out of memory* or *out of memory*)' },
  { id: 'search-model-catalog', title: 'Model Catalog', indexId: 'benchmarker-models', columns: ['model_id', 'name', 'architecture', 'parameter_count_billions', 'context_window', 'license', 'supports_tool_calling', 'source'], sort: [['model_id', 'asc']], query: '' },
  { id: 'search-error-events', title: 'Error Events', indexId: 'benchmarker-errors', columns: ['@timestamp', 'model_id', 'error_category', 'error_message', 'recovery_action', 'attempt_number', 'success', 'node_name'], sort: [['@timestamp', 'desc']], query: '' },
];
for (const s of searches) {
  const searchSource = { query: { language: 'kuery', query: s.query }, filter: [], indexRefName: 'index_0' };
  lines.push(JSON.stringify({
    type: 'search',
    id: s.id,
    attributes: { title: s.title, columns: s.columns, sort: s.sort, searchSourceJSON: JSON.stringify(searchSource) },
    references: [{ name: 'index_0', type: 'index-pattern', id: s.indexId }]
  }));
}

// Lens visualizations - build state programmatically
function makeLens(id, title, vizType, indexId, layers) {
  const state = {
    visualization: layers.visualization,
    query: { query: '', language: 'kuery' },
    filters: [],
    datasourceStates: { formBased: { layers: layers.formBased } }
  };
  return {
    type: 'lens',
    id,
    attributes: { title, visualizationType: vizType, state },
    references: [{ type: 'index-pattern', id: indexId, name: 'indexpattern-datasource-layer-layer1' }]
  };
}

// Results table
const resultsTableLayers = {
  visualization: { layerId: 'layer1', columns: ['col1', 'col2', 'col3', 'col4', 'col5', 'col6'].map(c => ({ columnId: c })) },
  formBased: {
    layer1: {
      columns: {
        col1: { label: 'Model', dataType: 'string', operationType: 'terms', sourceField: 'model_id', isBucketed: true, params: { size: 50, orderBy: { type: 'column', columnId: 'col2' }, orderDirection: 'desc' } },
        col2: { label: 'Timestamp', dataType: 'date', operationType: 'last_value', sourceField: '@timestamp', isBucketed: false, params: { sortField: '@timestamp', format: { id: 'date' } } },
        col3: { label: 'Passed', dataType: 'boolean', operationType: 'last_value', sourceField: 'passed', isBucketed: false, params: { sortField: '@timestamp' } },
        col4: { label: 'Throughput (tok/s)', dataType: 'number', operationType: 'average', sourceField: 'benchmark_metrics.throughput_tokens_per_sec', isBucketed: false, params: { format: { id: 'number' } } },
        col5: { label: 'ITL (ms)', dataType: 'number', operationType: 'average', sourceField: 'benchmark_metrics.itl_ms', isBucketed: false, params: { format: { id: 'number' } } },
        col6: { label: 'TTFT (ms)', dataType: 'number', operationType: 'average', sourceField: 'benchmark_metrics.ttft_ms', isBucketed: false, params: { format: { id: 'number' } } },
      },
      columnOrder: ['col1', 'col2', 'col3', 'col4', 'col5', 'col6']
    }
  }
};
lines.push(JSON.stringify(makeLens('vis-results-table', 'Results Comparison Table', 'lnsDatatable', 'benchmarker-results', resultsTableLayers)));

// Bar charts
function barChart(id, title, indexId, field, label, orderDir = 'desc') {
  const layers = {
    visualization: { legend: { isVisible: true, position: 'right' }, valueLabels: 'show', preferredSeriesType: 'bar_stacked', layers: [{ layerId: 'layer1', seriesType: 'bar', xAccessor: 'col-x', accessors: ['col-y'], layerType: 'data' }] },
    formBased: {
      layer1: {
        columns: {
          'col-x': { label: 'Model', dataType: 'string', operationType: 'terms', sourceField: 'model_id', isBucketed: true, params: { size: 20, orderBy: { type: 'column', columnId: 'col-y' }, orderDirection: orderDir } },
          'col-y': { label: label, dataType: 'number', operationType: 'average', sourceField: field, isBucketed: false, params: { format: { id: 'number' } } },
        },
        columnOrder: ['col-x', 'col-y']
      }
    }
  };
  return makeLens(id, title, 'lnsXY', indexId, layers);
}
lines.push(JSON.stringify(barChart('vis-throughput-bar', 'Throughput Bar Chart', 'benchmarker-results', 'benchmark_metrics.throughput_tokens_per_sec', 'Avg Throughput')));
lines.push(JSON.stringify(barChart('vis-itl-bar', 'ITL Bar Chart', 'benchmarker-results', 'benchmark_metrics.itl_ms', 'Avg ITL (ms)', 'asc')));
lines.push(JSON.stringify(barChart('vis-ttft-bar', 'TTFT Bar Chart', 'benchmarker-results', 'benchmark_metrics.ttft_ms', 'Avg TTFT (ms)', 'asc')));

// Throughput trend (time series)
const trendLayers = {
  visualization: { legend: { isVisible: true, position: 'right' }, valueLabels: 'hide', preferredSeriesType: 'line', layers: [{ layerId: 'layer1', seriesType: 'line', xAccessor: 'col-x', accessors: ['col-y'], splitAccessor: 'col-z', layerType: 'data' }] },
  formBased: {
    layer1: {
      columns: {
        'col-x': { label: 'Timestamp', dataType: 'date', operationType: 'date_histogram', sourceField: '@timestamp', isBucketed: true, params: { interval: 'auto', includeEmptyRows: true } },
        'col-y': { label: 'Avg Throughput', dataType: 'number', operationType: 'average', sourceField: 'benchmark_metrics.throughput_tokens_per_sec', isBucketed: false, params: { format: { id: 'number' } } },
        'col-z': { label: 'Model', dataType: 'string', operationType: 'terms', sourceField: 'model_id', isBucketed: true, params: { size: 10 } },
      },
      columnOrder: ['col-x', 'col-z', 'col-y']
    }
  }
};
lines.push(JSON.stringify(makeLens('vis-throughput-trend', 'Throughput Trend', 'lnsXY', 'benchmarker-results', trendLayers)));

// Resource charts
function resourceChart(id, title, field) {
  const layers = {
    visualization: { legend: { isVisible: true, position: 'right' }, valueLabels: 'hide', preferredSeriesType: 'line', layers: [{ layerId: 'layer1', seriesType: 'line', xAccessor: 'col-x', accessors: ['col-y'], layerType: 'data' }] },
    formBased: {
      layer1: {
        columns: {
          'col-x': { label: 'Timestamp', dataType: 'date', operationType: 'date_histogram', sourceField: '@timestamp', isBucketed: true, params: { interval: 'auto', includeEmptyRows: true } },
          'col-y': { label: field === 'system.cpu.total.pct' ? 'CPU %' : 'Memory Used %', dataType: 'number', operationType: 'average', sourceField: field, isBucketed: false, params: { format: { id: 'percent' } } },
        },
        columnOrder: ['col-x', 'col-y']
      }
    }
  };
  return makeLens(id, title, 'lnsXY', 'metrics-system', layers);
}
lines.push(JSON.stringify(resourceChart('vis-resource-cpu', 'Resource CPU', 'system.cpu.total.pct')));
lines.push(JSON.stringify(resourceChart('vis-resource-memory', 'Resource Memory', 'system.memory.used.pct')));

// Queue status bar chart
const queueStatusLayers = {
  visualization: { legend: { isVisible: true, position: 'right' }, valueLabels: 'show', preferredSeriesType: 'bar_stacked', layers: [{ layerId: 'layer1', seriesType: 'bar', xAccessor: 'col-x', accessors: ['col-y'], layerType: 'data' }] },
  formBased: {
    layer1: {
      columns: {
        'col-x': { label: 'Status', dataType: 'string', operationType: 'terms', sourceField: 'status', isBucketed: true, params: { size: 10, orderBy: { type: 'column', columnId: 'col-y' }, orderDirection: 'desc' } },
        'col-y': { label: 'Count', dataType: 'number', operationType: 'count', isBucketed: false, params: {} },
      },
      columnOrder: ['col-x', 'col-y']
    }
  }
};
lines.push(JSON.stringify(makeLens('vis-queue-status', 'Queue Status', 'lnsXY', 'benchmarker-queue', queueStatusLayers)));

// Dashboards
function makeDashboard(id, title, description, timeFrom, panelSpecs) {
  const panels = panelSpecs.map((p, i) => ({
    version: '8.0.0',
    gridData: p.gridData,
    panelIndex: String(i + 1),
    embeddableConfig: {},
    panelRefName: `panel_${i}`
  }));
  const references = panelSpecs.map((p, i) => ({ name: `panel_${i}`, type: p.type, id: p.id }));
  return {
    type: 'dashboard',
    id,
    attributes: {
      title,
      description,
      optionsJSON: JSON.stringify({ hidePanelTitles: false, useMargins: true }),
      panelsJSON: JSON.stringify(panels),
      timeRestore: true,
      timeTo: 'now',
      timeFrom
    },
    references
  };
}

const dashboards = [
  makeDashboard('dashboard-benchmark-results', 'Benchmark Results', 'Benchmark results comparison and key metrics by model', 'now-7d', [
    { type: 'lens', id: 'vis-results-table', gridData: { x: 0, y: 0, w: 48, h: 15, i: '1' } },
    { type: 'lens', id: 'vis-throughput-bar', gridData: { x: 0, y: 15, w: 16, h: 12, i: '2' } },
    { type: 'lens', id: 'vis-itl-bar', gridData: { x: 16, y: 15, w: 16, h: 12, i: '3' } },
    { type: 'lens', id: 'vis-ttft-bar', gridData: { x: 32, y: 15, w: 16, h: 12, i: '4' } },
  ]),
  makeDashboard('dashboard-performance-trends', 'Performance Trends', 'Throughput and latency trends over time', 'now-7d', [
    { type: 'lens', id: 'vis-throughput-trend', gridData: { x: 0, y: 0, w: 48, h: 15, i: '1' } },
  ]),
  makeDashboard('dashboard-resource-usage', 'Resource Usage', 'CPU and memory utilization over time', 'now-24h', [
    { type: 'lens', id: 'vis-resource-cpu', gridData: { x: 0, y: 0, w: 24, h: 15, i: '1' } },
    { type: 'lens', id: 'vis-resource-memory', gridData: { x: 24, y: 0, w: 24, h: 15, i: '2' } },
  ]),
  makeDashboard('dashboard-queue-status', 'Queue & Status', 'Queue view and status breakdown', 'now-7d', [
    { type: 'search', id: 'search-queue-view', gridData: { x: 0, y: 0, w: 48, h: 15, i: '1' } },
    { type: 'lens', id: 'vis-queue-status', gridData: { x: 0, y: 15, w: 24, h: 12, i: '2' } },
  ]),
  makeDashboard('dashboard-error-analysis', 'Error Analysis', 'Error events and analysis', 'now-7d', [
    { type: 'search', id: 'search-error-events', gridData: { x: 0, y: 0, w: 48, h: 20, i: '1' } },
  ]),
];

for (const d of dashboards) {
  lines.push(JSON.stringify(d));
}

const out = lines.join('\n') + '\n';
fs.writeFileSync('kibana/saved-objects.ndjson', out);

// Validate
let ok = 0, err = 0;
lines.forEach((line, i) => {
  try {
    JSON.parse(line);
    ok++;
  } catch (e) {
    console.error(`Line ${i + 1}: ${e.message}`);
    err++;
  }
});
console.log(`Generated ${lines.length} objects: ${ok} valid, ${err} invalid`);
