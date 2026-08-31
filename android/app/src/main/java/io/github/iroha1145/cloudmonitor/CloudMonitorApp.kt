package io.github.iroha1145.cloudmonitor

import android.app.Application
import android.webkit.MimeTypeMap
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.Decoder
import coil.decode.SvgDecoder
import coil.fetch.SourceResult
import coil.memory.MemoryCache
import coil.request.Options

class CloudMonitorApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        Thread(
            { runCatching { MimeTypeMap.getSingleton().getMimeTypeFromExtension("svg") } },
            "cm-mime-warm",
        ).apply { isDaemon = true }.start()
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components { add(EagerSvgDecoderFactory()) }
            .memoryCache {
                MemoryCache.Builder(this)
                    .maxSizePercent(0.20)
                    .build()
            }
            .crossfade(180)
            .allowHardware(true)
            .build()
}

/** Coil 2.7 首次 SVG 会在 MimeTypeMap 上锁；扩展名已是 svg 时不要等 mime。 */
class EagerSvgDecoderFactory(
    private val useViewBoundsAsIntrinsicSize: Boolean = true,
) : Decoder.Factory {
    private val inner = SvgDecoder.Factory(useViewBoundsAsIntrinsicSize)

    override fun create(result: SourceResult, options: Options, imageLoader: ImageLoader): Decoder? {
        inner.create(result, options, imageLoader)?.let { return it }
        if (!looksLikeSvg(result)) return null
        return SvgDecoder(result.source, options, useViewBoundsAsIntrinsicSize)
    }

    private fun looksLikeSvg(result: SourceResult): Boolean {
        if (result.mimeType.equals("image/svg+xml", ignoreCase = true)) return true
        val meta = result.source.metadata?.toString().orEmpty()
        return meta.contains(".svg", ignoreCase = true)
    }
}
