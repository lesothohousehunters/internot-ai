// Internot AI: the on-device language model, run natively with llama.cpp.
#pragma once
#include <functional>
#include <string>
#include <vector>

struct BrainMsg { std::string role, content; };

// Returns an empty string on success, otherwise a reason.
std::string brain_load(const std::string & path, int n_threads, int n_ctx);
// Streams each piece of text to on_piece; stop early by returning false from on_piece.
// Returns an empty string on success, otherwise a reason. stats gets "prompt_tokens,prompt_ms,gen_tokens,gen_ms".
std::string brain_generate(const std::vector<BrainMsg> & msgs, int max_tokens, float temp,
                           const std::function<bool(const std::string &)> & on_piece, std::string & stats);
void brain_stop();
void brain_free();
bool brain_loaded();
