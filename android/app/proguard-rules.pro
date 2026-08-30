# Compose / Kotlin
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,InnerClasses,EnclosingMethod,Signature,*Annotation*

# kotlinx.serialization（只保住数据模型，业务类交给 R8 混淆）
-keep @kotlinx.serialization.Serializable class io.github.iroha1145.cloudmonitor.data.** { *; }
-keep,includedescriptorclasses class io.github.iroha1145.cloudmonitor.data.**$$serializer { *; }
-keepclassmembers class io.github.iroha1145.cloudmonitor.data.** {
    *** Companion;
}
-keepclasseswithmembers class io.github.iroha1145.cloudmonitor.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}

# OkHttp / Conscrypt
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn okhttp3.**
-dontwarn okio.**

# Tink (security-crypto)
-dontwarn com.google.crypto.tink.**
-keep class androidx.security.crypto.** { *; }
