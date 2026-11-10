#include <stdint.h>
typedef struct { unsigned count; } aec_handle_t;
void aec_process(const aec_handle_t *, int16_t *, int16_t *, int16_t *);
