#!/usr/bin/env node
/**
 * Generate benchmarker-dashboard-m2.ndjson with M2 Kibana saved objects.
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

// 1. Index pattern: benchmark-stage2-* (time field started_at)
lines.push(obj('index-pattern', 'benchmark-stage2-wildcard', {
  title: 'benchmark-stage2-*',
  timeFieldName: 'started_at',
  allowHidden: false,
  fieldAttrs: '{}',
  fieldFormatMap: '{}',
  fields: '[]',
  runtimeFieldMap: '{}',
  sourceFilters: '[]',
  typeMigrationVersion: '8.0.0',
}));

// 2. Index pattern: benchmark-evaluations-* (time field @timestamp)
lines.push(obj('index-pattern', 'benchmark-evaluations-wildcard', {
  title: 'benchmark-evaluations-*',
  timeFieldName: '@timestamp',
  allowHidden: false,
  fieldAttrs: '{}',
  fieldFormatMap: '{}',
  fields: '[]',
  runtimeFieldMap: '{}',
  sourceFilters: '[]',
  typeMigrationVersion: '8.0.0',
}));

// 3. Index pattern: .benchmark-traces-* (time field @timestamp)
lines.push(obj('index-pattern', 'benchmark-traces-wildcard', {
  title: '.benchmark-traces-*',
  timeFieldName: '@timestamp',
  allowHidden: false,
  fieldAttrs: '{}',
  fieldFormatMap: '{}',
  fields: '[]',
  runtimeFieldMap: '{}',
  sourceFilters: '[]',
  typeMigrationVersion: '8.0.0',
}));

// 4. Lens: Stage 2 Quality Scores — stacked bar of suite pass/fail counts by model
// Uses benchmark-evaluations-* because suite_results is nested there
function lensXY(id, title, indexId, xCol, yCols, vizConfig) {
  const layerColumns = {};
  const columnOrder = [];

  layerColumns[vizConfig.xAccessor] = xCol;
  columnOrder.push(vizConfig.xAccessor);

  if (vizConfig.splitAccessor) {
    layerColumns[vizConfig.splitAccessor] = vizConfig.splitColumn;
    columnOrder.push(vizConfig.splitAccessor);
  }

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

lines.push(lensXY('vis-stage2-quality-scores', 'Stage 2 Quality Scores',
  'benchmark-evaluations-wildcard',
  {
    label: 'Model',
    dataType: 'string',
    operationType: 'terms',
    sourceField: 'model_id',
    isBucketed: true,
    params: { size: 20, orderBy: { type: 'column', columnId: 'col-y' }, orderDirection: 'desc' },
  },
  [{
    label: 'Count of Suite Results',
    dataType: 'number',
    operationType: 'count',
    isBucketed: false,
    scale: 'ratio',
    sourceField: '___records___',
    params: { emptyAsNull: true },
  }],
  {
    xAccessor: 'col-x',
    yAccessors: ['col-y'],
    preferredSeriesType: 'bar_stacked',
    seriesType: 'bar',
    splitAccessor: 'col-z',
    splitColumn: {
      label: 'Suite Status',
      dataType: 'string',
      operationType: 'terms',
      sourceField: 'suite_results.status',
      isBucketed: true,
      params: { size: 5, orderBy: { type: 'alphabetical' }, orderDirection: 'asc' },
    },
  }
));

// 5. Saved search: Trace Explorer — links to traces for failed suites
// Filtered for failed/error suite results on benchmark-evaluations-*
const searchSourceTrace = JSON.stringify({
  query: { language: 'kuery', query: 'suite_results.status:fail OR suite_results.status:error' },
  filter: [],
  indexRefName: 'index_0',
});
lines.push(obj('search', 'search-trace-explorer', {
  title: 'Trace Explorer',
  columns: ['model_id', 'suite_results.suite', 'suite_results.trace_id', 'status', '@timestamp'],
  sort: [['@timestamp', 'desc']],
  kibanaSavedObjectMeta: { searchSourceJSON: searchSourceTrace },
  typeMigrationVersion: '10.11.0',
}, [{ name: 'index_0', type: 'index-pattern', id: 'benchmark-evaluations-wildcard' }]));

// 6. Dashboard: LLM Benchmarker M2 Overview
function dashboard(id, title, description, timeFrom, panels) {
  const dashboardPanels = panels.map((p, i) => ({
    version: '8.8.0',
    type: p.embedType || p.type,
    gridData: p.gridData,
    panelIndex: String(i + 1),
    embeddableConfig: p.embeddableConfig ?? {},
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
    controlGroupInput: {
      controlStyle: 'oneLine',
      chainingSystem: 'HIERARCHICAL',
      panels: {
        control_panel_1: {
          order: 0,
          type: 'optionsListControl',
          grow: false,
          width: 'medium',
          explicitInput: {
            id: 'control_panel_1',
            dataViewId: 'benchmark-stage2-wildcard',
            fieldName: 'status',
            title: 'Gate Decision',
            selectedOptions: [],
            sortSettings: { sortBy: '_count', fallback: true },
          },
        },
      },
    },
    timeRestore: true,
    timeTo: 'now',
    timeFrom,
    version: 1,
  }, references);
}

lines.push(dashboard('dashboard-llm-benchmarker-m2', 'LLM Benchmarker M2 Overview',
  'Stage 2 eval quality scores, gate filter, and trace explorer for benchmark evaluations.',
  'now-7d',
  [
    // Top row: Quality scores (larger)
    {
      type: 'lens',
      id: 'vis-stage2-quality-scores',
      gridData: { x: 0, y: 0, w: 32, h: 18, i: '1' },
      embedType: 'lens',
    },
    // Gate filter control (smaller, right side)
    {
      type: 'search',
      id: 'search-trace-explorer',
      gridData: { x: 32, y: 0, w: 16, h: 18, i: '2' },
      embedType: 'search',
    },
  ]
));

const out = lines.join('\n') + '\n';
const outPath = path.join(__dirname, 'benchmarker-dashboard-m2.ndjson');
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
