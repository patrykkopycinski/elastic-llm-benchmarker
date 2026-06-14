#!/usr/bin/env node
/**
 * Generate benchmarker-dashboard.ndjson with Kibana saved objects.
 */
const fs = require('fs');
const path = require('path');

const lines = [];

function obj(type, id, attributes, references = []) {
  return JSON.stringify({
    type,
    id,
    attributes,
    references,
    coreMigrationVersion: '8.8.0',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 'WzEsMV0=',
    managed: false,
  });
}

// 1. Index pattern: benchmarker-results-* (time field @timestamp)
lines.push(obj('index-pattern', 'benchmarker-results-wildcard', {
  title: 'benchmarker-results-*',
  timeFieldName: '@timestamp',
  allowHidden: false,
  fieldAttrs: '{}',
  fieldFormatMap: '{}',
  fields: '[]',
  runtimeFieldMap: '{}',
  sourceFilters: '[]',
  typeMigrationVersion: '8.0.0',
}));

// 2. Index pattern: benchmarker-eval-reports (for pass rate)
lines.push(obj('index-pattern', 'benchmarker-eval-reports', {
  title: 'benchmarker-eval-reports',
  timeFieldName: '@timestamp',
  allowHidden: false,
  fieldAttrs: '{}',
  fieldFormatMap: '{}',
  fields: '[]',
  runtimeFieldMap: '{}',
  sourceFilters: '[]',
  typeMigrationVersion: '8.0.0',
}));

// 3. Saved search: Raw Benchmark Results
const searchSource = JSON.stringify({
  query: { language: 'kuery', query: '' },
  filter: [],
  indexRefName: 'index_0',
});
lines.push(obj('search', 'search-raw-benchmark-results', {
  title: 'Raw Benchmark Results',
  columns: ['@timestamp', 'model_id', 'passed', 'benchmark_metrics.throughput_tokens_per_sec', 'benchmark_metrics.concurrency_level', 'gpu_utilization.total_vram_used_gb'],
  sort: [['@timestamp', 'desc']],
  kibanaSavedObjectMeta: { searchSourceJSON: searchSource },
  typeMigrationVersion: '10.11.0',
}, [{ name: 'index_0', type: 'index-pattern', id: 'benchmarker-results-wildcard' }]));

// Helper for Lens XY charts
function lensXY(id, title, indexId, xCol, yCols, vizConfig) {
  const layerColumns = {};
  const columnOrder = [];

  // X column
  layerColumns[vizConfig.xAccessor] = xCol;
  columnOrder.push(vizConfig.xAccessor);

  // Split column if present
  if (vizConfig.splitAccessor) {
    layerColumns[vizConfig.splitAccessor] = vizConfig.splitColumn;
    columnOrder.push(vizConfig.splitAccessor);
  }

  // Y columns
  yCols.forEach((yc, i) => {
    const colId = vizConfig.yAccessors[i];
    layerColumns[colId] = yc;
    columnOrder.push(colId);
  });

  const state = {
    datasourceStates: {
      formBased: {
        layers: {
          layer1: {
            columns: layerColumns,
            columnOrder,
            incompleteColumns: {},
            indexPatternId: indexId,
          },
        },
      },
    },
    filters: [],
    query: { language: 'kuery', query: vizConfig.query || '' },
    visualization: {
      legend: { isVisible: true, position: 'right' },
      preferredSeriesType: vizConfig.preferredSeriesType || 'line',
      valueLabels: vizConfig.valueLabels || 'hide',
      layers: [{
        layerId: 'layer1',
        layerType: 'data',
        seriesType: vizConfig.seriesType || 'line',
        xAccessor: vizConfig.xAccessor,
        accessors: vizConfig.yAccessors,
        ...(vizConfig.splitAccessor ? { splitAccessor: vizConfig.splitAccessor } : {}),
      }],
    },
  };

  return obj('lens', id, {
    title,
    visualizationType: 'lnsXY',
    state,
    typeMigrationVersion: '10.1.0',
  }, [{ type: 'index-pattern', id: indexId, name: 'indexpattern-datasource-layer-layer1' }]);
}

// 4. Lens: Throughput vs Concurrency
lines.push(lensXY('vis-throughput-vs-concurrency', 'Throughput vs Concurrency',
  'benchmarker-results-wildcard',
  {
    label: 'Concurrency',
    dataType: 'number',
    operationType: 'terms',
    sourceField: 'benchmark_metrics.concurrency_level',
    isBucketed: true,
    params: { size: 20, orderBy: { type: 'alphabetical' }, orderDirection: 'asc' },
  },
  [{
    label: 'Throughput (tok/s)',
    dataType: 'number',
    operationType: 'average',
    sourceField: 'benchmark_metrics.throughput_tokens_per_sec',
    isBucketed: false,
    params: { format: { id: 'number' } },
  }],
  {
    xAccessor: 'col-x',
    yAccessors: ['col-y'],
    preferredSeriesType: 'line',
    seriesType: 'line',
    splitAccessor: 'col-z',
    splitColumn: {
      label: 'Model',
      dataType: 'string',
      operationType: 'terms',
      sourceField: 'model_id',
      isBucketed: true,
      params: { size: 10, orderBy: { type: 'alphabetical' }, orderDirection: 'asc' },
    },
  }
));

// 5. Lens: Latency Distribution (grouped bar of ITL, TTFT, P99 by model)
lines.push(lensXY('vis-latency-distribution', 'Latency Distribution',
  'benchmarker-results-wildcard',
  {
    label: 'Model',
    dataType: 'string',
    operationType: 'terms',
    sourceField: 'model_id',
    isBucketed: true,
    params: { size: 20, orderBy: { type: 'column', columnId: 'col-itl' }, orderDirection: 'asc' },
  },
  [
    {
      label: 'Avg ITL (ms)',
      dataType: 'number',
      operationType: 'average',
      sourceField: 'benchmark_metrics.itl_ms',
      isBucketed: false,
      params: { format: { id: 'number' } },
    },
    {
      label: 'Avg TTFT (ms)',
      dataType: 'number',
      operationType: 'average',
      sourceField: 'benchmark_metrics.ttft_ms',
      isBucketed: false,
      params: { format: { id: 'number' } },
    },
    {
      label: 'P99 Latency (ms)',
      dataType: 'number',
      operationType: 'average',
      sourceField: 'benchmark_metrics.p99_latency_ms',
      isBucketed: false,
      params: { format: { id: 'number' } },
    },
  ],
  {
    xAccessor: 'col-x',
    yAccessors: ['col-itl', 'col-ttft', 'col-p99'],
    preferredSeriesType: 'bar_stacked',
    seriesType: 'bar',
    valueLabels: 'show',
  }
));

// 6. Lens: GPU Memory Usage over time by model
lines.push(lensXY('vis-gpu-memory-usage', 'GPU Memory Usage',
  'benchmarker-results-wildcard',
  {
    label: 'Timestamp',
    dataType: 'date',
    operationType: 'date_histogram',
    sourceField: '@timestamp',
    isBucketed: true,
    params: { interval: 'auto', includeEmptyRows: true },
  },
  [{
    label: 'VRAM Used (GB)',
    dataType: 'number',
    operationType: 'average',
    sourceField: 'gpu_utilization.total_vram_used_gb',
    isBucketed: false,
    params: { format: { id: 'number' } },
  }],
  {
    xAccessor: 'col-x',
    yAccessors: ['col-y'],
    preferredSeriesType: 'line',
    seriesType: 'line',
    splitAccessor: 'col-z',
    splitColumn: {
      label: 'Model',
      dataType: 'string',
      operationType: 'terms',
      sourceField: 'model_id',
      isBucketed: true,
      params: { size: 10, orderBy: { type: 'alphabetical' }, orderDirection: 'asc' },
    },
  }
));

// 7. Lens: Stage 2 Gate Pass Rate (pie/metric showing % passed from eval-reports)
// We'll use a metric showing average of passed boolean as percentage
function lensMetric(id, title, indexId, metricCol, query = '') {
  const state = {
    datasourceStates: {
      formBased: {
        layers: {
          layer1: {
            columns: {
              'col-metric': metricCol,
            },
            columnOrder: ['col-metric'],
            incompleteColumns: {},
            indexPatternId: indexId,
          },
        },
      },
    },
    filters: [],
    query: { language: 'kuery', query },
    visualization: {
      layerId: 'layer1',
      layerType: 'data',
      metricAccessor: 'col-metric',
    },
  };

  return obj('lens', id, {
    title,
    visualizationType: 'lnsMetric',
    state,
    typeMigrationVersion: '10.1.0',
  }, [{ type: 'index-pattern', id: indexId, name: 'indexpattern-datasource-layer-layer1' }]);
}

lines.push(lensMetric('vis-stage2-pass-rate', 'Stage 2 Gate Pass Rate',
  'benchmarker-eval-reports',
  {
    label: 'Pass Rate',
    dataType: 'number',
    operationType: 'average',
    sourceField: 'passed_count',
    isBucketed: false,
    params: { format: { id: 'percent' } },
  }
));

// 8. Lens: Benchmark Duration by Model (bar chart using p99 latency as proxy for duration)
lines.push(lensXY('vis-benchmark-duration', 'Benchmark Duration by Model',
  'benchmarker-results-wildcard',
  {
    label: 'Model',
    dataType: 'string',
    operationType: 'terms',
    sourceField: 'model_id',
    isBucketed: true,
    params: { size: 20, orderBy: { type: 'column', columnId: 'col-y' }, orderDirection: 'desc' },
  },
  [{
    label: 'Avg Benchmark Duration Proxy (ms)',
    dataType: 'number',
    operationType: 'average',
    sourceField: 'benchmark_metrics.p99_latency_ms',
    isBucketed: false,
    params: { format: { id: 'number' } },
  }],
  {
    xAccessor: 'col-x',
    yAccessors: ['col-y'],
    preferredSeriesType: 'bar',
    seriesType: 'bar',
    valueLabels: 'show',
  }
));

// 9. Dashboard: LLM Benchmarker Overview
function dashboard(id, title, description, timeFrom, panels) {
  const dashboardPanels = panels.map((p, i) => ({
    version: '8.8.0',
    type: p.embedType || p.type,
    gridData: p.gridData,
    panelIndex: String(i + 1),
    embeddableConfig: {},
    panelRefName: `panel_${i}`,
  }));

  const references = panels.map((p, i) => ({
    name: `panel_${i}`,
    type: p.type,
    id: p.id,
  }));

  return obj('dashboard', id, {
    title,
    description,
    optionsJSON: JSON.stringify({ hidePanelTitles: false, useMargins: true }),
    panelsJSON: JSON.stringify(dashboardPanels),
    timeRestore: true,
    timeTo: 'now',
    timeFrom,
    version: 1,
  }, references);
}

lines.push(dashboard('dashboard-llm-benchmarker-overview', 'LLM Benchmarker Overview',
  'Overview of LLM benchmark results including throughput, latency, GPU memory, pass rates, and duration.',
  'now-7d',
  [
    // Top row: throughput + latency
    { type: 'lens', id: 'vis-throughput-vs-concurrency', gridData: { x: 0, y: 0, w: 24, h: 15, i: '1' }, embedType: 'lens' },
    { type: 'lens', id: 'vis-latency-distribution', gridData: { x: 24, y: 0, w: 24, h: 15, i: '2' }, embedType: 'lens' },
    // Middle row: GPU + pass rate
    { type: 'lens', id: 'vis-gpu-memory-usage', gridData: { x: 0, y: 15, w: 24, h: 15, i: '3' }, embedType: 'lens' },
    { type: 'lens', id: 'vis-stage2-pass-rate', gridData: { x: 24, y: 15, w: 24, h: 15, i: '4' }, embedType: 'lens' },
    // Bottom row: duration + table
    { type: 'lens', id: 'vis-benchmark-duration', gridData: { x: 0, y: 30, w: 24, h: 15, i: '5' }, embedType: 'lens' },
    { type: 'search', id: 'search-raw-benchmark-results', gridData: { x: 24, y: 30, w: 24, h: 15, i: '6' }, embedType: 'search' },
  ]
));

const out = lines.join('\n') + '\n';
const outPath = path.join(__dirname, 'benchmarker-dashboard.ndjson');
fs.writeFileSync(outPath, out);

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
if (err === 0) {
  console.log(`Wrote ${outPath}`);
  process.exitCode = 0;
} else {
  process.exitCode = 1;
}
