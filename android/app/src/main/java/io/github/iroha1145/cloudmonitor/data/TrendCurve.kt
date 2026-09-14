package io.github.iroha1145.cloudmonitor.data

import kotlin.math.sqrt

/**
 * Fritsch–Carlson slopes for the daily trend stroke.
 * Matches Liveline's `drawSpline` plus its same-Y live tip: the latest day
 * is flattened so the curve meets the trailing dashed reference horizontally.
 */
fun monotoneTrendSlopes(xs: FloatArray, ys: FloatArray): FloatArray {
    val n = xs.size
    require(n == ys.size)
    if (n == 0) return floatArrayOf()
    if (n == 1) return floatArrayOf(0f)
    val h = FloatArray(n - 1)
    val delta = FloatArray(n - 1)
    for (i in 0 until n - 1) {
        h[i] = xs[i + 1] - xs[i]
        delta[i] = if (h[i] == 0f) 0f else (ys[i + 1] - ys[i]) / h[i]
    }
    val m = FloatArray(n)
    m[0] = delta[0]
    m[n - 1] = delta[n - 2]
    for (i in 1 until n - 1) {
        m[i] = if (delta[i - 1] * delta[i] <= 0f) 0f else (delta[i - 1] + delta[i]) / 2f
    }
    for (i in 0 until n - 1) {
        if (delta[i] == 0f) {
            m[i] = 0f
            m[i + 1] = 0f
        } else {
            val alpha = m[i] / delta[i]
            val beta = m[i + 1] / delta[i]
            val steep = alpha * alpha + beta * beta
            if (steep > 9f) {
                val scale = 3f / sqrt(steep)
                m[i] = scale * alpha * delta[i]
                m[i + 1] = scale * beta * delta[i]
            }
        }
    }
    m[n - 1] = 0f
    return m
}
