// Internot AI: the on-device language model, run natively with llama.cpp.
// One model, one conversation at a time. The part of the prompt that did not change since the
// last answer stays in memory, so follow-up questions start answering quickly.
#include "brain.h"
#include "llama.h"
#include <atomic>
#include <chrono>
#include <mutex>

static llama_model * g_model = nullptr;
static llama_context * g_ctx = nullptr;
static std::vector<llama_token> g_past;      // tokens currently held in the context
static std::atomic<bool> g_stop{false};
static std::mutex g_mu;
static bool g_backend = false;

static double now_ms() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

void brain_free() {
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_past.clear();
}
bool brain_loaded() { return g_ctx != nullptr; }
void brain_stop() { g_stop = true; }

std::string brain_load(const std::string & path, int n_threads, int n_ctx) {
    brain_free();
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_backend) { llama_backend_init(); g_backend = true; }
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    g_model = llama_model_load_from_file(path.c_str(), mp);
    if (!g_model) return "The model file could not be opened.";
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = n_ctx;
    cp.n_batch = 256;
    cp.n_ubatch = 256;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) { llama_model_free(g_model); g_model = nullptr; return "Not enough memory to start the model."; }
    return "";
}

static std::string apply_template(const std::vector<BrainMsg> & msgs) {
    std::vector<llama_chat_message> chat;
    for (const auto & m : msgs) chat.push_back({ m.role.c_str(), m.content.c_str() });
    const char * tmpl = llama_model_chat_template(g_model, nullptr);
    std::vector<char> buf(4096);
    for (const auto & m : msgs) buf.resize(buf.size() + m.content.size() * 2);
    int n = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, buf.data(), (int) buf.size());
    if (n > (int) buf.size()) { buf.resize(n + 1); n = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, buf.data(), (int) buf.size()); }
    if (n < 0) {   // unknown template: fall back to ChatML, which most small models understand
        std::string s;
        for (const auto & m : msgs) s += "<|im_start|>" + m.role + "\n" + m.content + "<|im_end|>\n";
        return s + "<|im_start|>assistant\n";
    }
    return std::string(buf.data(), n);
}

// Holds back bytes that end in the middle of a UTF-8 character, so every piece sent is valid text.
static size_t complete_utf8(const std::string & s) {
    size_t n = s.size(), i = n;
    for (int back = 0; back < 4 && i > 0; back++) {
        unsigned char c = s[i - 1];
        if ((c & 0xC0) == 0x80) { i--; continue; }   // continuation byte
        int need = (c & 0x80) == 0 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        return (n - (i - 1) >= (size_t) need) ? n : i - 1;
    }
    return n;
}

std::string brain_generate(const std::vector<BrainMsg> & msgs, int max_tokens, float temp,
                           const std::function<bool(const std::string &)> & on_piece, std::string & stats) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_ctx) return "The model is not loaded.";
    g_stop = false;
    const llama_vocab * vocab = llama_model_get_vocab(g_model);
    const std::string prompt = apply_template(msgs);
    int n = -llama_tokenize(vocab, prompt.c_str(), (int) prompt.size(), nullptr, 0, true, true);
    std::vector<llama_token> toks(n);
    if (llama_tokenize(vocab, prompt.c_str(), (int) prompt.size(), toks.data(), n, true, true) < 0) return "The question could not be read.";
    const int n_ctx = (int) llama_n_ctx(g_ctx);
    if ((int) toks.size() + max_tokens + 8 > n_ctx) {   // keep the newest part of a very long prompt
        int keep = n_ctx - max_tokens - 8; if (keep < 64) return "The question is too long.";
        toks.erase(toks.begin(), toks.end() - keep);
    }

    // Reuse what is already in memory: only the new part of the conversation is processed.
    size_t common = 0;
    while (common < g_past.size() && common < toks.size() && g_past[common] == toks[common]) common++;
    if (common == toks.size()) common--;   // the last prompt token must be processed to get an answer
    llama_memory_t mem = llama_get_memory(g_ctx);
    if (!llama_memory_seq_rm(mem, 0, (llama_pos) common, -1)) { llama_memory_clear(mem, true); common = 0; }
    g_past.resize(common);

    const double t0 = now_ms();
    const int n_batch = (int) llama_n_batch(g_ctx);
    for (size_t i = common; i < toks.size(); i += n_batch) {
        int len = (int) std::min<size_t>(n_batch, toks.size() - i);
        if (llama_decode(g_ctx, llama_batch_get_one(toks.data() + i, len)) != 0) { llama_memory_clear(mem, true); g_past.clear(); return "The model ran out of memory."; }
        g_past.insert(g_past.end(), toks.begin() + i, toks.begin() + i + len);
        if (g_stop) return "";
    }
    const double t1 = now_ms();

    llama_sampler * smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), 64, 1.1f, 0.0f, 0.0f));
    if (temp <= 0.01f) llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    else {
        llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.9f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    }
    std::string pending; int made = 0; std::string err;
    for (; made < max_tokens && !g_stop; made++) {
        llama_token t = llama_sampler_sample(smpl, g_ctx, -1);
        if (llama_vocab_is_eog(vocab, t)) break;
        char piece[256];
        int len = llama_token_to_piece(vocab, t, piece, sizeof piece, 0, false);
        if (len > 0) pending.append(piece, len);
        size_t ok = complete_utf8(pending);
        if (ok > 0) { if (!on_piece(pending.substr(0, ok))) g_stop = true; pending.erase(0, ok); }
        if ((int) g_past.size() + 1 >= n_ctx) break;
        llama_token one = t;
        if (llama_decode(g_ctx, llama_batch_get_one(&one, 1)) != 0) { err = "The model ran out of memory."; break; }
        g_past.push_back(t);
    }
    if (!pending.empty() && err.empty()) on_piece(pending);
    llama_sampler_free(smpl);
    const double t2 = now_ms();
    stats = std::to_string(toks.size() - common) + "," + std::to_string((int) (t1 - t0)) + "," + std::to_string(made) + "," + std::to_string((int) (t2 - t1));
    return err;
}
