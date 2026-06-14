// CUDA kernel for selective scan
#include <cuda_runtime.h>

#define BLOCK_SIZE 256

extern "C" __global__ void selective_scan_kernel(
    const float* __restrict__ u,
    const float* __restrict__ delta,
    const float* __restrict__ A,
    const float* __restrict__ B,
    const float* __restrict__ C,
    float* __restrict__ out,
    float* __restrict__ h_last,
    int batch, int dim, int dstate, int seqlen
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= batch * dim) return;
    // selective scan computation
    int b = idx / dim;
    int d = idx % dim;
    for (int t = 0; t < seqlen; t++) {
        float delta_t = delta[t * batch * dim + b * dim + d];
        // ... scan logic
    }
}

__host__ void launch_selective_scan(
    const float* u, const float* delta,
    const float* A, const float* B, const float* C,
    float* out, float* h_last,
    int batch, int dim, int dstate, int seqlen
) {
    int threads = BLOCK_SIZE;
    int blocks = (batch * dim + threads - 1) / threads;
    selective_scan_kernel<<<blocks, threads>>>(
        u, delta, A, B, C, out, h_last,
        batch, dim, dstate, seqlen
    );
}
