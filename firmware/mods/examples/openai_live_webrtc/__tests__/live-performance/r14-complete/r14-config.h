#ifndef R14_COMPLETE_CONFIG_H
#define R14_COMPLETE_CONFIG_H
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include "driver/i2s_std.h"
extern unsigned r14Rate, r14DMA, r14Internal, r14MeterEvery, r14MeterFrame;
extern unsigned r14Priming, r14StallUs, r14StallEvery, r14FeedSample;
extern atomic_bool r14Tail;
extern void *r14LocalAudio;
extern atomic_uint r14SPIBytes;
void r14RegisterAudio(i2s_chan_handle_t tx, i2s_chan_handle_t rx);
void r14AudioTick(i2s_chan_handle_t tx, i2s_chan_handle_t rx);
void r14OutputRead(unsigned available, unsigned got, const int16_t *samples, unsigned requested);
#endif
