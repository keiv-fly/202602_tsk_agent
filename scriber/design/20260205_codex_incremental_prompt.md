Create a minimal step to improve the scriber, according to requirements.md. The improvement can either be a new test or an implementation that solves this test. This is a TDD, so tests come first. The test should have a text description that tells what it is doing.

If all the features of the requirements are implemented say it and do not add anything. 
 
The code should have either a test or the code that solves the test. Not both. If there is a test that is failing then you need to implement this test and not create a new test.
 
## If it is the test then: 
1. only the test file is changed and this particular test is allowed to fail
2. Add describe for logical grouping of the tests
3. Add/change TSDoc description for describe, so that it explains what this group does
4. Add `it` for individual tests
5. Add TSDoc for those tests that will have the following:
  1. What is the goal of this test? (`# Goal` section)
  2. What does this test do? (`# What it Does` section)
  3. How this test works? (`# Implementation details` section)
  4. What part of the requirements it covers (including the number and short description of the requirements) and rationale why it covers the requirements (`# Requirement Coverage`)


## If it is the implementation then:  
1. the test could only be changed if it needs some different setup
2. You usually cannot change the test logic, but you can change the test logic if it is really needed.
3. For every function provide a description in TSDoc format that should have the following:
  1. Description of the function (short description and long description)
  2. Input
  3. Output
  4. Description of how the function works, including some information about internals using text (optional. Use it at you descretion) 
 

# Write in the final summary what have you chosen: 
1. Write test
2. Write implementation
3. All features are implemented - do nothing