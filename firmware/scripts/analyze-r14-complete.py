#!/usr/bin/env python3
"""Summarize measured R14 experiment records without converting omissions into passes."""
import argparse
import collections
import json
import statistics
from pathlib import Path


def median(rows, measure):
    return round(statistics.median(map(measure, rows)), 4) if rows else None


def measured_cpu(row, names):
    return sum(row['cpu'].get(name, 0) for name in names) * 100 / row['cpu']['durationUs']


def camera_cpu(row):
    before = {task['name']: task['cpuUs'] for task in row['tasksBefore']}
    return sum((task['cpuUs'] - before[task['name']]) * 100 / row['cpu']['durationUs']
               for task in row['tasksAfter'] if task['name'] in ('camera', 'cam_task') and task['name'] in before)


def grouped(rows, keys, measurements):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[tuple(row[key] for key in keys)].append(row)
    return [{**dict(zip(keys, key)), 'n': len(group),
             **{name: median(group, measure) for name, measure in measurements.items()}}
            for key, group in groups.items()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--image', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.log.read_text().splitlines() if line.strip()]
    phases = collections.defaultdict(list)
    for row in rows:
        phases[row['phase']].append(row)
    tracked = ('main', 'spiLoop', 'live_audio', 'AUD_SRC', 'aenc_0', 'Adec', 'ARender', 'pc_send', 'pc_task')
    main_spi = ('main', 'spiLoop')
    result = {
        'phase_counts': {key: len(group) for key, group in phases.items()},
        'guard': phases['guard'],
        'end_marker': bool(phases['done']),
        'failures': [r for r in rows if 'failure' in r['phase'] or r['phase'] == 'failed'],
        'P02': grouped(phases['P02'], ('candidate',), {
            'tracked_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, tracked),
            'i2s_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, ('live_audio',)),
            'internal_free_bytes': lambda r: r['memory']['internalFree'],
            'encoded_frames': lambda r: r['media']['encodedFrames'],
        }),
        'P02_pitch_values': {
            rate: [r['pitch'] for r in phases['P02-pitch'] if r['rate'] == rate]
            for rate in (48000, 24000)
        },
        'P02_opus': grouped(phases['P02-opus'], ('rate',), {
            'tracked_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, tracked),
            'i2s_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, ('live_audio',)),
            'decoder_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, ('Adec',)),
            'capture_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, ('AUD_SRC',)),
            'internal_free_bytes': lambda r: r['memory']['internalFree'],
            'encoded_frames': lambda r: r['media']['encodedFrames'],
            'pcm_bytes': lambda r: r['after']['receivedBytes'],
            'output_samples': lambda r: r['media']['renderedSamples'],
        }),
        'P03': grouped(phases['P03'], ('candidate',), {
            'capture_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, ('AUD_SRC',)),
            'tracked_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, tracked),
            'internal_free_bytes': lambda r: r['memory']['internalFree'],
            'internal_minimum_bytes': lambda r: r['memory']['internalMinimum'],
        }),
        'P05': grouped(phases['P05'], ('mouth',), {
            'callbacks': lambda r: r['mouthCallbacks'], 'mouth_changes': lambda r: r['mouthChanges'],
            'spi_bytes': lambda r: r['after']['spiBytes'] - r['before']['spiBytes'],
            'main_spi_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, main_spi),
        }),
        'P06': grouped(phases['P06'], ('full',), {
            'spi_bytes': lambda r: r['counters']['spiBytes'],
            'main_spi_cpu_ms': lambda r: sum(r['cpu'].get(t, 0) for t in main_spi) / 1000,
            'elapsed_ms': lambda r: r['cpu']['durationUs'] / 1000,
        }),
        'P07': grouped(phases['P07'], ('batch',), {
            'cpu_us_per_packet': lambda r: r['cpuUs'] / r['packets'],
            'groups': lambda r: r['groups'],
            'pcm_samples': lambda r: r['samples'],
            'allocations': lambda r: r['allocations'],
        }),
        'P08': grouped(phases['P08'], ('pattern', 'priming'), {
            'first_pcm_dequeue_after_sample_start_ms': lambda r: (r['after']['firstDequeuedUs'] - r['before']['atUs']) / 1000,
            'missing_pcm_ms': lambda r: r['media']['silenceMs'],
            'pcm_bytes': lambda r: r['after']['receivedBytes'],
            'maximum_queue_bytes': lambda r: r['after']['maxQueueBytes'],
            'maximum_arrival_timer_lateness_ms': lambda r: r['lateMax'],
        }),
        'P08_hold': phases['P08-hold'],
        'P08_cancellation': phases['P08-cancel'],
        'P08_priming_gate_validated': bool(phases['P08-cancel']) if phases['P08'] or phases['P08-cancel'] else None,
        'P09': grouped(phases['P09'], ('dma', 'stall'), {
            'rx_dma_overflows': lambda r: r['after']['rxQueueOverflows'] - r['before']['rxQueueOverflows'],
            'tx_dma_overflows': lambda r: r['after']['txQueueOverflows'] - r['before']['txQueueOverflows'],
            'maximum_service_gap_us': lambda r: r['after']['maxTickGapUs'],
            'internal_minimum_bytes': lambda r: r['memory']['internalMinimum'],
        }),
        'P10': phases['P10'],
        'P11': grouped(phases['P11'], ('scenario',), {
            'main_spi_cpu_one_core_equivalent_percent': lambda r: measured_cpu(r, main_spi),
            'camera_cpu_one_core_equivalent_percent': camera_cpu,
            'internal_free_bytes': lambda r: r['memory']['internalFree'],
            'psram_free_bytes': lambda r: r['memory']['psramFree'],
        }),
        'P12': phases['P12'],
        'P12_delay': phases['P12-delay'],
        'provider': phases['provider'],
        'cycles': {'completed': len(phases['cycle']), 'failed': len(phases['cycle-failure']),
                   'all_successful_cycles_inactive_after_stop': bool(phases['cycle']) and
                   all(r['inactive'] for r in phases['cycle']),
                   'successful_before_internal_free_bytes': [r['before']['internalFree'] for r in phases['cycle']],
                   'successful_after_internal_free_bytes': [r['after']['internalFree'] for r in phases['cycle']]},
        'provider_diagnostics': dict(collections.Counter(r['code'] for r in phases['provider-diagnostic'])),
        'sdk_diagnostics': dict(collections.Counter(r['code'] for r in phases['sdk-diagnostic'])),
        'soak_samples': phases['soak'],
        'soak_end': phases['soak-end'],
    }
    if args.image:
        result['image'] = json.loads(args.image.read_text())
    serialized = json.dumps(result, indent=2) + '\n'
    if args.out:
        args.out.write_text(serialized)
    else:
        print(serialized, end='')


if __name__ == '__main__':
    main()
