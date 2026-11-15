// Bridge between the Java plugin and the native model.
#include <jni.h>
#include <string>
#include <vector>
#include "brain.h"

static std::string jstr(JNIEnv * env, jstring s) {
    if (!s) return "";
    const char * c = env->GetStringUTFChars(s, nullptr); std::string r(c); env->ReleaseStringUTFChars(s, c); return r;
}
// Java's modified UTF-8 cannot carry 4-byte characters (emoji), so text goes back as raw bytes.
static jbyteArray jbytes(JNIEnv * env, const std::string & s) {
    jbyteArray a = env->NewByteArray((jsize) s.size()); env->SetByteArrayRegion(a, 0, (jsize) s.size(), (const jbyte *) s.data()); return a;
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_internot_app_BrainPlugin_nativeLoad(JNIEnv * env, jclass, jstring path, jint threads, jint ctx) {
    return env->NewStringUTF(brain_load(jstr(env, path), threads, ctx).c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_internot_app_BrainPlugin_nativeGenerate(JNIEnv * env, jclass, jobjectArray roles, jobjectArray contents,
                                                  jint max_tokens, jfloat temp, jobject sink) {
    std::vector<BrainMsg> msgs;
    jsize n = env->GetArrayLength(roles);
    for (jsize i = 0; i < n; i++) {
        jstring r = (jstring) env->GetObjectArrayElement(roles, i), c = (jstring) env->GetObjectArrayElement(contents, i);
        msgs.push_back({ jstr(env, r), jstr(env, c) });
        env->DeleteLocalRef(r); env->DeleteLocalRef(c);
    }
    jclass cls = env->GetObjectClass(sink);
    jmethodID piece = env->GetMethodID(cls, "piece", "([B)Z");
    std::string stats;
    std::string err = brain_generate(msgs, max_tokens, temp, [&](const std::string & p) {
        jbyteArray b = jbytes(env, p); jboolean go = env->CallBooleanMethod(sink, piece, b); env->DeleteLocalRef(b);
        if (env->ExceptionCheck()) { env->ExceptionClear(); return false; }
        return (bool) go;
    }, stats);
    return env->NewStringUTF(err.empty() ? ("ok:" + stats).c_str() : err.c_str());
}

extern "C" JNIEXPORT void JNICALL Java_org_internot_app_BrainPlugin_nativeStop(JNIEnv *, jclass) { brain_stop(); }
extern "C" JNIEXPORT void JNICALL Java_org_internot_app_BrainPlugin_nativeFree(JNIEnv *, jclass) { brain_free(); }
