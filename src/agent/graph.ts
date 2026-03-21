import { END, START, StateGraph } from '@langchain/langgraph';
import { AgentAnnotation } from './state.js';
import {
  idleNode,
  discoverModelsNode,
  discoverPromisingModelsNode,
  evaluateModelNode,
  runBenchmarkNode,
  storeResultsNode,
  exposeApiNode,
  runKibanaEvalNode,
  handleErrorNode,
  routeFromIdle,
  routeAfterEvaluation,
  routeAfterBenchmark,
  routeAfterError,
} from './nodes.js';

const workflow = new StateGraph(AgentAnnotation)
  .addNode('idle', idleNode)
  .addNode('discover_models', discoverModelsNode)
  .addNode('discover_promising_models', discoverPromisingModelsNode)
  .addNode('evaluate_model', evaluateModelNode)
  .addNode('run_benchmark', runBenchmarkNode)
  .addNode('store_results', storeResultsNode)
  .addNode('expose_api', exposeApiNode)
  .addNode('run_kibana_eval', runKibanaEvalNode)
  .addNode('handle_error', handleErrorNode)
  .addEdge(START, 'idle')
  .addConditionalEdges('idle', routeFromIdle, {
    discover_models: 'discover_models',
    discover_promising_models: 'discover_promising_models',
  })
  .addEdge('discover_models', 'evaluate_model')
  .addEdge('discover_promising_models', 'evaluate_model')
  .addConditionalEdges('evaluate_model', routeAfterEvaluation, {
    run_benchmark: 'run_benchmark',
    idle: 'idle',
  })
  .addConditionalEdges('run_benchmark', routeAfterBenchmark, {
    store_results: 'store_results',
    handle_error: 'handle_error',
  })
  .addEdge('store_results', 'expose_api')
  .addEdge('expose_api', 'run_kibana_eval')
  .addEdge('run_kibana_eval', 'evaluate_model')
  .addConditionalEdges('handle_error', routeAfterError, {
    idle: 'idle',
    evaluate_model: 'evaluate_model',
    [END]: END,
  });

export const graph = workflow.compile();
