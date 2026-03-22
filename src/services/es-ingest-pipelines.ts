import { Client } from '@elastic/elasticsearch';

export const PIPELINE_NAME = 'benchmarker-results-pipeline';

export const RESULTS_PIPELINE = {
  description: 'Parse raw vLLM benchmark output into structured metric fields',
  processors: [
    {
      grok: {
        field: 'raw_output',
        patterns: [
          '%{MLDATA}Output token throughput \\(tok/s\\):%{SPACE}%{NUMBER:_parsed_throughput:float}%{MLDATA}Mean TTFT \\(ms\\):%{SPACE}%{NUMBER:_parsed_ttft_ms:float}%{MLDATA}Mean ITL \\(ms\\):%{SPACE}%{NUMBER:_parsed_itl_ms:float}%{MLDATA}P99 ITL \\(ms\\):%{SPACE}%{NUMBER:_parsed_p99_itl_ms:float}',
        ],
        pattern_definitions: {
          MLDATA: '[\\s\\S]*',
        },
        ignore_failure: true,
        if: 'ctx.raw_output != null && ctx.raw_output.length() > 0',
      },
    },
    {
      grok: {
        field: 'raw_output',
        patterns: [
          '%{MLDATA}P99 TTFT \\(ms\\):%{SPACE}%{NUMBER:_parsed_p99_ttft_ms:float}',
        ],
        pattern_definitions: {
          MLDATA: '[\\s\\S]*',
        },
        ignore_failure: true,
        if: 'ctx.raw_output != null && ctx._parsed_p99_ttft_ms == null',
      },
    },
    {
      script: {
        source: `
          if (ctx._parsed_throughput != null) {
            if (ctx.parsed_metrics == null) { ctx.parsed_metrics = new HashMap(); }
            ctx.parsed_metrics.throughput_tokens_per_sec = ctx._parsed_throughput;
            ctx.parsed_metrics.ttft_ms = ctx._parsed_ttft_ms;
            ctx.parsed_metrics.itl_ms = ctx._parsed_itl_ms;
            ctx.parsed_metrics.p99_itl_ms = ctx._parsed_p99_itl_ms;
            if (ctx._parsed_p99_ttft_ms != null) {
              ctx.parsed_metrics.p99_ttft_ms = ctx._parsed_p99_ttft_ms;
            }
          }
          ctx.remove('_parsed_throughput');
          ctx.remove('_parsed_ttft_ms');
          ctx.remove('_parsed_itl_ms');
          ctx.remove('_parsed_p99_itl_ms');
          ctx.remove('_parsed_p99_ttft_ms');
        `,
        ignore_failure: true,
        if: 'ctx._parsed_throughput != null',
      },
    },
  ],
};

export async function registerIngestPipelines(client: Client): Promise<void> {
  await client.ingest.putPipeline({
    id: PIPELINE_NAME,
    ...RESULTS_PIPELINE,
  });
}
