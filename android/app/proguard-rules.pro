-keepattributes *Annotation*, InnerClasses, Signature
-keepclassmembers class ** {
    @kotlinx.serialization.SerialName <fields>;
}
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.bouncycastle.**
-keep class io.github.iroha1145.cloudmonitor.data.** { *; }
