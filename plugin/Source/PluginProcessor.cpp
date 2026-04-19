#include "PluginProcessor.h"
#include "PluginEditor.h"

// --- SynthVoice ---
bool SynthVoice::canPlaySound (juce::SynthesiserSound* sound) {
    return dynamic_cast<SynthSound*>(sound) != nullptr;
}

void SynthVoice::startNote (int midiNoteNumber, float velocity, juce::SynthesiserSound*, int) {
    auto freq = (float)juce::MidiMessage::getMidiNoteInHertz(midiNoteNumber);
    osc.setFrequency(freq);
    adsr.setParameters({0.1f, 0.3f, 0.5f, 0.8f});
    adsr.noteOn();
}

void SynthVoice::stopNote (float velocity, bool allowTailOff) {
    adsr.noteOff();
    if (!allowTailOff || !adsr.isActive()) clearCurrentNote();
}

void SynthVoice::prepareToPlay (double sampleRate, int samplesPerBlock, int outputChannels) {
    juce::dsp::ProcessSpec spec;
    spec.maximumBlockSize = samplesPerBlock;
    spec.sampleRate = sampleRate;
    spec.numChannels = outputChannels;

    osc.prepare(spec);
    osc.initialise([](float x) { return x / juce::MathConstants<float>::pi; }); // Sawtooth wave
    
    gain.prepare(spec);
    gain.setGainLinear(0.1f);

    adsr.setSampleRate(sampleRate);
    isPrepared = true;
}

void SynthVoice::renderNextBlock (juce::AudioBuffer<float>& outputBuffer, int startSample, int numSamples) {
    if (!isPrepared) return;
    
    juce::AudioBuffer<float> synthBuffer(outputBuffer.getNumChannels(), numSamples);
    synthBuffer.clear();

    juce::dsp::AudioBlock<float> audioBlock(synthBuffer);
    juce::dsp::ProcessContextReplacing<float> context(audioBlock);

    osc.process(context);
    gain.process(context);
    adsr.applyEnvelopeToBuffer(synthBuffer, 0, numSamples);

    for (int channel = 0; channel < outputBuffer.getNumChannels(); ++channel) {
        outputBuffer.addFrom(channel, startSample, synthBuffer, channel, 0, numSamples);
    }
    
    if (!adsr.isActive()) clearCurrentNote();
}

// --- Processor ---
LydbolgeLabProcessor::LydbolgeLabProcessor()
     : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
       apvts(*this, nullptr, "Parameters", createParameterLayout())
{
    synth.addSound(new SynthSound());
    for (int i = 0; i < 8; i++) {
        synth.addVoice(new SynthVoice());
    }
}

LydbolgeLabProcessor::~LydbolgeLabProcessor() {}

juce::AudioProcessorValueTreeState::ParameterLayout LydbolgeLabProcessor::createParameterLayout() {
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
    params.push_back(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID{"masterVol", 1}, "Master Volume", 0.0f, 1.0f, 0.8f));
    return { params.begin(), params.end() };
}

void LydbolgeLabProcessor::prepareToPlay (double sampleRate, int samplesPerBlock) {
    synth.setCurrentPlaybackSampleRate(sampleRate);
    for (int i = 0; i < synth.getNumVoices(); i++) {
        if (auto voice = dynamic_cast<SynthVoice*>(synth.getVoice(i))) {
            voice->prepareToPlay(sampleRate, samplesPerBlock, getTotalNumOutputChannels());
        }
    }
}

void LydbolgeLabProcessor::releaseResources() {}

void LydbolgeLabProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) {
    juce::ScopedNoDenormals noDenormals;
    for (auto i = getTotalNumInputChannels(); i < getTotalNumOutputChannels(); ++i)
        buffer.clear (i, 0, buffer.getNumSamples());
        
    synth.renderNextBlock(buffer, midiMessages, 0, buffer.getNumSamples());
    
    float masterVol = apvts.getRawParameterValue("masterVol")->load();
    buffer.applyGain(masterVol);
}

juce::AudioProcessorEditor* LydbolgeLabProcessor::createEditor() {
    return new LydbolgeLabEditor(*this);
}

// Boilerplate
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new LydbolgeLabProcessor();
}
