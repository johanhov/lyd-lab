cmake_minimum_required(VERSION 3.20)
project(LydbolgeLab VERSION 1.0.0)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
    juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        master
)
FetchContent_MakeAvailable(juce)

juce_add_plugin(LydbolgeLab
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    FORMATS VST3 Standalone
    PRODUCT_NAME "Lydbolge-Lab"
)

target_sources(LydbolgeLab PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
)

target_compile_definitions(LydbolgeLab PUBLIC JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(LydbolgeLab PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_gui_basics
    juce::juce_dsp
)

juce_generate_juce_header(LydbolgeLab)
